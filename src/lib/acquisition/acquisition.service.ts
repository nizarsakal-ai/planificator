import { resolveCompanyAccess } from "@/lib/company-access"
import { AcquisitionMessageContentRepository } from "@/lib/acquisition/content/message-content.repository"
import type { SanitizedMessageContent } from "@/lib/acquisition/content/message-content.types"
// ─── Assistant Consultations — service d'acquisition (fondation) ─────────────
// Transforme un email entrant admissible en brouillon de consultation
// (WorksiteImportDraft), de façon idempotente et strictement multi-tenant.
//
// Périmètre V1 (fondation) :
// - AUCUN connecteur Gmail, AUCUN appel IA, AUCUN téléchargement de pièce
//   jointe, AUCUNE création de client ou de chantier.
// - Inactif par défaut : les futurs points d'entrée (connecteur, cron, UI)
//   devront vérifier isAcquisitionEnabled() avant tout traitement.

import type { PrismaClient, Prisma } from "@prisma/client"
import { createHash } from "crypto"
import { prisma } from "@/lib/prisma"
import {
  registerIncomingMessageSchema,
  type RegisterIncomingMessageInput,
} from "@/lib/validations/acquisition"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { PartnerEligibilityResolver } from "@/lib/acquisition/partner-eligibility.resolver"
import type { PartnerEligibilityResolverPort } from "@/lib/acquisition/partner-eligibility.resolver"
import { PartnerRegistryRepository } from "@/lib/acquisition/persistence/partner-registry.repository"
import { acquireAcquisitionMessageIdentityAdvisoryXactLock } from "@/lib/acquisition/acquisition-message-identity-lock"

import { normalizeSenderAddress } from "@/lib/acquisition/normalize-sender-address"

export { normalizeSenderAddress, type NormalizedSender } from "@/lib/acquisition/normalize-sender-address"
export { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"

// ─── Normalisation expéditeur (sans décision d’éligibilité) ───────────────────
// Composition root local : wiring défaut Resolver→Repository ici uniquement.
// Le chemin métier n’appelle que PartnerEligibilityResolverPort (voir
// docs/acquisition-partner-registry-cutover.md). Pas de conteneur DI.

export type RegisterIncomingMessageDeps = {
  /** Injecté en tests ; défaut = resolver registre sur le même `db`. */
  eligibilityResolver?: PartnerEligibilityResolverPort
  uploadActorId?: string
  uploadContent?: SanitizedMessageContent
  uploadAttachmentBytes?: readonly Uint8Array[]
}

async function requireUploadCompanyAdmin(
  db: Pick<PrismaClient, "user">,
  actorId: string | undefined,
  companyId: string,
): Promise<void> {
  const actor = actorId ? await db.user.findUnique({
    where: { id: actorId },
    select: {
      active: true, role: true, companyId: true,
      company: { select: { active: true } },
      employeeProfiles: {
        select: { companyId: true, role: true, active: true, company: { select: { active: true } } },
      },
    },
  }) : null
  const access = actor?.active ? resolveCompanyAccess(actor, companyId) : null
  if (
    access?.companyId !== companyId ||
    (access.role !== "ADMIN" && access.role !== "SUPER_ADMIN") ||
    (actor?.role === "SUPER_ADMIN" && !actor.company?.active)
  ) {
    throw new Error("Acteur UPLOAD non autorisé")
  }
}

// ─── Enregistrement idempotent d'un message entrant ──────────────────────────

export type RegisterIncomingMessageResult =
  | {
      created: boolean
      outcome: "DRAFT_CREATED"
      messageId: string
      draftId: string
    }
  | {
      created: boolean
      outcome: "REJECTED"
      messageId: string
      draftId: null
      errorCode: "INVALID_SENDER" | "SENDER_NOT_ELIGIBLE"
    }

/**
 * Enregistre un message entrant de façon idempotente pour un tenant donné.
 *
 * Garanties :
 * - contexte tenant obligatoire (companyId validé, jamais déduit) ;
 * - unicité (companyId, source, sourceMailboxKey, externalMessageId) : un rappel
 *   avec le même message ne crée aucun doublon (message, brouillon ou PJ) ;
 * - PLAN-ACQ-MULTI-GMAIL-002/003 : scan Gmail avec mailboxKey non vide réutilise
 *   d’abord la ligne legacy (sourceMailboxKey="") au même externalMessageId
 *   (anti-doublon Providence) — sans promotion destructive du mailboxKey ;
 *   sous pg_advisory_xact_lock(companyId, source, externalMessageId) avant
 *   relecture/création (race concurrente legacy↔moderne sérialisée) ;
 * - écritures liées exécutées dans une transaction (rollback complet en cas
 *   d'échec de la création du brouillon) ;
 * - message non admissible : enregistré en REJECTED (traçabilité +
 *   idempotence face aux re-scans), jamais de brouillon ;
 * - message admissible : message DRAFT_CREATED + pièces jointes DISCOVERED
 *   + un unique WorksiteImportDraft en PENDING_EXTRACTION.
 */
export async function registerIncomingMessage(
  input: RegisterIncomingMessageInput,
  db: PrismaClient = prisma,
  deps: RegisterIncomingMessageDeps = {}
): Promise<RegisterIncomingMessageResult> {
  const data = registerIncomingMessageSchema.parse(input)

  const uploadBytes = deps.uploadAttachmentBytes
  if (data.source === "UPLOAD" && (
    (uploadBytes?.length ?? 0) !== data.attachments.length ||
    uploadBytes?.some((bytes, index) => bytes.byteLength !== data.attachments[index].sizeBytes) ||
    (uploadBytes?.reduce((sum, bytes) => sum + bytes.byteLength, 0) ?? 0) > 10 * 1024 * 1024
  )) {
    throw new Error("Octets des pièces UPLOAD invalides")
  }

  const uploadActorId = deps.uploadActorId
  if (data.source === "UPLOAD") {
    await requireUploadCompanyAdmin(db, uploadActorId, data.companyId)
  }

  const includeDraft = { draft: { select: { id: true } } } as const

  // Idempotence exacte : tenant + boîte + id externe.
  const existing = await db.acquisitionMessage.findUnique({
    where: {
      companyId_source_sourceMailboxKey_externalMessageId: {
        companyId: data.companyId,
        source: data.source,
        sourceMailboxKey: data.sourceMailboxKey,
        externalMessageId: data.externalMessageId,
      },
    },
    include: includeDraft,
  })
  if (existing) {
    // Expéditeur devenu partenaire depuis le rejet (ex. domaine ajouté au registre) :
    // le message est promu en brouillon au lieu de rester rejeté à vie (idempotence).
    if (
      existing.status === "REJECTED" &&
      existing.lastErrorCode === "SENDER_NOT_ELIGIBLE" &&
      !existing.draft
    ) {
      const promoted = await promoteRejectedMessageIfNowEligible(db, data, existing.id, deps)
      if (promoted) return promoted
    }
    return toResult(existing.id, existing.draft?.id ?? null, existing.status, false, existing.lastErrorCode)
  }

  // Anti-doublon legacy↔moderne hors TX (chemin chaud) — TX revalide sous verrou.
  if (data.source === "GMAIL") {
    const collapsed = await findCollapsedGmailIdentity(
      db,
      data.companyId,
      data.externalMessageId,
      data.sourceMailboxKey
    )
    if (collapsed)
      return toResult(
        collapsed.id,
        collapsed.draft?.id ?? null,
        collapsed.status,
        false,
        collapsed.lastErrorCode
      )
  }

  const eligibilityResolver =
    deps.eligibilityResolver ??
    new PartnerEligibilityResolver(new PartnerRegistryRepository(db))

  const normalized = normalizeSenderAddress(data.senderEmail)
  let resolvedPartnerId: string | null = null
  let eligible = false
  if (normalized) {
    const resolved = await eligibilityResolver.resolveEligibleSender(
      data.companyId,
      normalized.email,
      normalized.domain
    )
    eligible = resolved !== null
    resolvedPartnerId = resolved?.partner.id ?? null
  }
  const errorCode: "INVALID_SENDER" | "SENDER_NOT_ELIGIBLE" | null =
    normalized === null ? "INVALID_SENDER" : eligible ? null : "SENDER_NOT_ELIGIBLE"

  try {
    const result = await db.$transaction(async (tx) => {
      // F1-003 : sérialise legacy "" vs moderne avant relectures / create.
      if (data.source === "GMAIL") {
        await acquireAcquisitionMessageIdentityAdvisoryXactLock(tx, {
          companyId: data.companyId,
          source: data.source,
          externalMessageId: data.externalMessageId,
        })
      }

      const racedExact = await tx.acquisitionMessage.findUnique({
        where: {
          companyId_source_sourceMailboxKey_externalMessageId: {
            companyId: data.companyId,
            source: data.source,
            sourceMailboxKey: data.sourceMailboxKey,
            externalMessageId: data.externalMessageId,
          },
        },
        include: includeDraft,
      })
      if (racedExact) {
        return {
          messageId: racedExact.id,
          draftId: racedExact.draft?.id ?? null,
          status: racedExact.status,
          created: false,
          lastErrorCode: racedExact.lastErrorCode,
        }
      }
      if (data.source === "GMAIL") {
        const collapsed = await findCollapsedGmailIdentity(
          tx,
          data.companyId,
          data.externalMessageId,
          data.sourceMailboxKey
        )
        if (collapsed) {
          return {
            messageId: collapsed.id,
            draftId: collapsed.draft?.id ?? null,
            status: collapsed.status,
            created: false,
            lastErrorCode: collapsed.lastErrorCode,
          }
        }
      }

      if (data.source === "UPLOAD") {
        await requireUploadCompanyAdmin(tx, uploadActorId, data.companyId)
      }

      const message = await tx.acquisitionMessage.create({
        data: {
          companyId: data.companyId,
          source: data.source,
          externalMessageId: data.externalMessageId,
          sourceMailboxKey: data.sourceMailboxKey,
          threadId: data.threadId ?? null,
          resolvedPartnerId: eligible ? resolvedPartnerId : null,
          senderEmail: normalized?.email ?? data.senderEmail.trim().toLowerCase().slice(0, 320),
          senderDomain: normalized?.domain ?? "",
          subject: data.subject,
          receivedAt: data.receivedAt,
          status: eligible ? "DRAFT_CREATED" : "REJECTED",
          lastErrorCode: errorCode,
          lastErrorMessage:
            errorCode === "INVALID_SENDER"
              ? "Adresse expéditeur invalide"
              : errorCode === "SENDER_NOT_ELIGIBLE"
                ? "Expéditeur non admissible (registre partenaires)"
                : null,
          rawMetadata: (data.rawMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      })

      let draftId: string | null = null
      if (eligible) {
        if (data.attachments.length > 0) {
          const attachmentRows = data.attachments.map((attachment, index) => ({
            companyId: data.companyId,
            acquisitionMessageId: message.id,
            attachmentKey: buildAttachmentKey(attachment, index),
            externalAttachmentId: attachment.externalAttachmentId ?? null,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            category: categorizeAttachment(attachment.mimeType, attachment.filename),
            status: "DISCOVERED" as const,
          }))
          if (data.source === "UPLOAD" && uploadBytes) {
            for (const [index, attachment] of attachmentRows.entries()) {
              await tx.acquisitionAttachment.create({
                data: {
                  ...attachment,
                  uploadSource: { create: { bytes: Buffer.from(uploadBytes[index]) } },
                },
              })
            }
          } else {
            await tx.acquisitionAttachment.createMany({ data: attachmentRows })
          }
        }

        if (data.source === "UPLOAD" && deps.uploadContent) {
          await new AcquisitionMessageContentRepository(tx).upsertNormalized({
            companyId: data.companyId,
            acquisitionMessageId: message.id,
            sanitized: deps.uploadContent,
            fetchedAt: new Date(),
          })
        }

        const draft = await tx.worksiteImportDraft.create({
          data: {
            companyId: data.companyId,
            acquisitionMessageId: message.id,
            status: "PENDING_EXTRACTION",
          },
        })
        draftId = draft.id
      }

      if (data.source === "UPLOAD" && uploadActorId) {
        await tx.historyLog.create({
          data: {
            companyId: data.companyId,
            actorId: uploadActorId,
            action: "CREATED",
            entityType: "AcquisitionEmlImport",
            entityId: message.id,
            detail: message.status,
          },
        })
      }

      return {
        messageId: message.id,
        draftId,
        status: message.status,
        created: true,
        lastErrorCode: errorCode,
      }
    })

    return toResult(
      result.messageId,
      result.draftId,
      result.status,
      result.created,
      result.lastErrorCode
    )
  } catch (e) {
    // Course concurrente : un autre appel a inséré le même message entre le
    // findUnique et la transaction → relire et répondre de façon idempotente.
    if (isUniqueConstraintError(e)) {
      const raced = await db.acquisitionMessage.findUnique({
        where: {
          companyId_source_sourceMailboxKey_externalMessageId: {
            companyId: data.companyId,
            source: data.source,
            sourceMailboxKey: data.sourceMailboxKey,
            externalMessageId: data.externalMessageId,
          },
        },
        include: includeDraft,
      })
      if (raced)
        return toResult(raced.id, raced.draft?.id ?? null, raced.status, false, raced.lastErrorCode)

      if (data.source === "GMAIL") {
        const collapsed = await findCollapsedGmailIdentity(
          db,
          data.companyId,
          data.externalMessageId,
          data.sourceMailboxKey
        )
        if (collapsed)
          return toResult(
            collapsed.id,
            collapsed.draft?.id ?? null,
            collapsed.status,
            false,
            collapsed.lastErrorCode
          )
      }
    }
    throw e
  }
}


/**
 * Promotion REJECTED(SENDER_NOT_ELIGIBLE) → DRAFT_CREATED quand l'expéditeur est
 * désormais admissible. Même verrou d'identité que la création ; relecture sous
 * verrou (une promotion concurrente ne crée jamais deux brouillons).
 * Retourne null si l'expéditeur n'est toujours pas admissible.
 */
async function promoteRejectedMessageIfNowEligible(
  db: PrismaClient,
  data: ReturnType<typeof registerIncomingMessageSchema.parse>,
  messageId: string,
  deps: RegisterIncomingMessageDeps
): Promise<RegisterIncomingMessageResult | null> {
  const normalized = normalizeSenderAddress(data.senderEmail)
  if (!normalized) return null
  const eligibilityResolver =
    deps.eligibilityResolver ??
    new PartnerEligibilityResolver(new PartnerRegistryRepository(db))
  const resolved = await eligibilityResolver.resolveEligibleSender(
    data.companyId,
    normalized.email,
    normalized.domain
  )
  if (!resolved) return null

  return db.$transaction(async (tx) => {
    await acquireAcquisitionMessageIdentityAdvisoryXactLock(tx, {
      companyId: data.companyId,
      source: data.source,
      externalMessageId: data.externalMessageId,
    })
    const current = await tx.acquisitionMessage.findFirst({
      where: { id: messageId, companyId: data.companyId },
      include: { draft: { select: { id: true } } },
    })
    if (!current) return null
    if (current.draft || current.status !== "REJECTED") {
      return toResult(current.id, current.draft?.id ?? null, current.status, false, current.lastErrorCode)
    }

    await tx.acquisitionMessage.update({
      where: { id: current.id },
      data: {
        status: "DRAFT_CREATED",
        resolvedPartnerId: resolved.partner.id,
        senderEmail: normalized.email,
        senderDomain: normalized.domain,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    })
    if (data.attachments.length > 0) {
      await tx.acquisitionAttachment.createMany({
        data: data.attachments.map((a, index) => ({
          companyId: data.companyId,
          acquisitionMessageId: current.id,
          attachmentKey: buildAttachmentKey(a, index),
          externalAttachmentId: a.externalAttachmentId ?? null,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          category: categorizeAttachment(a.mimeType, a.filename),
          status: "DISCOVERED" as const,
        })),
        skipDuplicates: true,
      })
    }
    const draft = await tx.worksiteImportDraft.create({
      data: {
        companyId: data.companyId,
        acquisitionMessageId: current.id,
        status: "PENDING_EXTRACTION",
      },
    })
    return toResult(current.id, draft.id, "DRAFT_CREATED", true, null)
  })
}

type LegacyMessageRow = {
  id: string
  status: string
  lastErrorCode: string | null
  draft: { id: string } | null
}

/**
 * Collapse logique legacy "" ↔ moderne connectionId (même externalMessageId).
 * Moderne A vs moderne B : ne collapse pas (identités distinctes).
 */
async function findCollapsedGmailIdentity(
  db: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  externalMessageId: string,
  sourceMailboxKey: string
): Promise<LegacyMessageRow | null> {
  if (sourceMailboxKey !== "") {
    return findLegacyGmailMessage(db, companyId, externalMessageId)
  }
  return findOldestModernGmailMessage(db, companyId, externalMessageId)
}

async function findLegacyGmailMessage(
  db: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  externalMessageId: string
): Promise<LegacyMessageRow | null> {
  return db.acquisitionMessage.findUnique({
    where: {
      companyId_source_sourceMailboxKey_externalMessageId: {
        companyId,
        source: "GMAIL",
        sourceMailboxKey: "",
        externalMessageId,
      },
    },
    include: { draft: { select: { id: true } } },
  })
}

async function findOldestModernGmailMessage(
  db: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  externalMessageId: string
): Promise<LegacyMessageRow | null> {
  return db.acquisitionMessage.findFirst({
    where: {
      companyId,
      source: "GMAIL",
      externalMessageId,
      NOT: { sourceMailboxKey: "" },
    },
    orderBy: { createdAt: "asc" },
    include: { draft: { select: { id: true } } },
  })
}

// ─── Lectures strictement tenant-scopées ─────────────────────────────────────

/** Lecture d'un brouillon TOUJOURS conditionnée au tenant. */
export async function getImportDraftForCompany(
  companyId: string,
  draftId: string,
  db: PrismaClient = prisma
) {
  if (!companyId) throw new Error("companyId requis")
  return db.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    include: {
      acquisitionMessage: { include: { attachments: true } },
    },
  })
}

/** Lecture d'un message TOUJOURS conditionnée au tenant. */
export async function getAcquisitionMessageForCompany(
  companyId: string,
  messageId: string,
  db: PrismaClient = prisma
) {
  if (!companyId) throw new Error("companyId requis")
  return db.acquisitionMessage.findFirst({
    where: { id: messageId, companyId },
    include: { attachments: true, draft: true },
  })
}

// ─── Helpers internes ────────────────────────────────────────────────────────

function toResult(
  messageId: string,
  draftId: string | null,
  status: string,
  created: boolean,
  errorCode: string | null
): RegisterIncomingMessageResult {
  if (status === "DRAFT_CREATED" && draftId) {
    return { created, outcome: "DRAFT_CREATED", messageId, draftId }
  }
  return {
    created,
    outcome: "REJECTED",
    messageId,
    draftId: null,
    errorCode: errorCode === "INVALID_SENDER" ? "INVALID_SENDER" : "SENDER_NOT_ELIGIBLE",
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "P2002"
  )
}

/**
 * Identité STABLE et déterministe d'une pièce jointe dans son message :
 * 1. "ext:<id>"  — identifiant Gmail normalisé (trim) s'il existe et clé courte ;
 *    IDs longs : "ext-sha256:<digest>" pour protéger la taille de l'index B-tree
 *    (@@unique acquisitionMessageId+attachmentKey). L'externalAttachmentId
 *    complet reste stocké séparément pour le téléchargement Gmail.
 * 2. "part:<id>" — identifiant de partie MIME sinon ;
 * 3. "ord:<n>"   — ordinal (position dans le message) en dernier recours.
 * Le filename seul n'est JAMAIS utilisé comme identité. Combinée à
 * l'unicité (acquisitionMessageId, attachmentKey) en base, cette clé rend
 * l'enregistrement des pièces jointes idempotent même sans identifiant
 * Gmail exploitable.
 */
const ATTACHMENT_KEY_MAX_SAFE_LENGTH = 1024

export function buildAttachmentKey(
  attachment: { externalAttachmentId?: string; partId?: string },
  index: number
): string {
  const ext = attachment.externalAttachmentId?.trim()
  if (ext) {
    const rawKey = `ext:${ext}`
    if (rawKey.length <= ATTACHMENT_KEY_MAX_SAFE_LENGTH) return rawKey
    const digest = createHash("sha256").update(ext, "utf8").digest("hex")
    return `ext-sha256:${digest}`
  }
  const part = attachment.partId?.trim()
  if (part) return `part:${part}`
  return `ord:${index}`
}

/** Catégorisation simple par MIME/extension — métadonnées uniquement en V1. */
export function categorizeAttachment(
  mimeType: string,
  filename: string
): "PLAN" | "PHOTO" | "DOCUMENT" | "ARCHIVE" | "UNSUPPORTED" | "UNKNOWN" {
  const mime = mimeType.toLowerCase()
  const name = filename.toLowerCase()

  if (mime === "application/pdf" || name.endsWith(".pdf")) return "PLAN"
  if (mime.startsWith("image/")) return "PHOTO"
  if (
    mime.includes("msword") ||
    mime.includes("officedocument") ||
    mime.includes("opendocument") ||
    mime === "text/plain" ||
    mime === "text/csv"
  )
    return "DOCUMENT"
  if (
    mime === "application/zip" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/x-rar-compressed" ||
    name.endsWith(".zip") ||
    name.endsWith(".rar") ||
    name.endsWith(".7z")
  )
    return "ARCHIVE"
  if (mime === "application/octet-stream") return "UNKNOWN"
  if (mime.startsWith("application/") || mime.startsWith("video/") || mime.startsWith("audio/"))
    return "UNSUPPORTED"
  return "UNKNOWN"
}
