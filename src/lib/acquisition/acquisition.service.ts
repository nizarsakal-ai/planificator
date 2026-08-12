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

export { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"

type RegisterIncomingMessageDiagStage =
  | "REGISTER_INCOMING_MESSAGE_SCHEMA_PARSE"
  | "REGISTER_INCOMING_MESSAGE_IDEMPOTENCE_LOOKUP"
  | "REGISTER_INCOMING_MESSAGE_ELIGIBILITY_RESOLVE"
  | "REGISTER_INCOMING_MESSAGE_TRANSACTION"

type RegisterIncomingMessageDiagErrorName = "ZodError" | "Error" | "UnknownError"

/** Marqueur partagé avec sync.service : un seul log diag par exception. */
const MESSAGE_INGESTION_DIAG_LOGGED = Symbol.for(
  "planificator.acquisitionMessageIngestionDiagLogged"
)

function wasMessageIngestionDiagLogged(error: unknown): boolean {
  try {
    return Boolean(
      error &&
        typeof error === "object" &&
        MESSAGE_INGESTION_DIAG_LOGGED in (error as object)
    )
  } catch {
    return false
  }
}

function markMessageIngestionDiagLogged(error: unknown): void {
  try {
    if (!error || typeof error !== "object") return
    Object.defineProperty(error, MESSAGE_INGESTION_DIAG_LOGGED, {
      value: true,
      enumerable: false,
      configurable: true,
    })
  } catch {
    // ignore
  }
}

/**
 * Diagnostic temporaire (PLAN-ACQ-MESSAGE-INGESTION-DIAG-001).
 * Flag OFF => no-op. Exceptions inattendues uniquement — jamais de contenu métier.
 * Stage le plus profond uniquement (marque l'exception pour les catches englobants).
 */
function logRegisterIncomingMessageDiag(
  gmailMessageId: string,
  stage: RegisterIncomingMessageDiagStage,
  error: unknown
): void {
  try {
    if (process.env.ACQUISITION_GMAIL_DIAGNOSTIC !== "true") return
    if (wasMessageIngestionDiagLogged(error)) return

    let errorName: RegisterIncomingMessageDiagErrorName = "UnknownError"
    let errorCode = "UNKNOWN"
    let retryable = true
    let zodPath: Array<string | number> | undefined
    let zodIssueCode: string | undefined

    try {
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        (error as { name: unknown }).name === "ZodError"
      ) {
        errorName = "ZodError"
        errorCode = "ZOD_ERROR"

        // PLAN-ACQ-MESSAGE-INGESTION-ZOD-PATH-001 — enrichissement Zod
        // uniquement au stage SCHEMA_PARSE.
        if (stage === "REGISTER_INCOMING_MESSAGE_SCHEMA_PARSE") {
          try {
            const issues = (error as { issues?: unknown }).issues
            if (Array.isArray(issues) && issues.length > 0) {
              const first = issues[0]
              if (first && typeof first === "object") {
                const rawCode = (first as { code?: unknown }).code
                if (typeof rawCode === "string" && /^[a-z_]+$/.test(rawCode)) {
                  zodIssueCode = rawCode
                }
                const rawPath = (first as { path?: unknown }).path
                if (
                  Array.isArray(rawPath) &&
                  rawPath.every((p) => typeof p === "string" || typeof p === "number")
                ) {
                  zodPath = rawPath as Array<string | number>
                }
              }
            }
          } catch {
            // ignore Zod issue inspection failures
          }
        }
      } else if (error instanceof Error) {
        errorName = "Error"
        let rawCode: unknown
        try {
          rawCode = (error as { code?: unknown }).code
        } catch {
          rawCode = undefined
        }
        if (typeof rawCode === "string" && /^P\d{4}$/.test(rawCode)) {
          errorCode = rawCode
        }
      }

      let rawRetryable: unknown
      try {
        rawRetryable =
          error && typeof error === "object" && "retryable" in error
            ? (error as { retryable: unknown }).retryable
            : undefined
      } catch {
        rawRetryable = undefined
      }
      if (typeof rawRetryable === "boolean") retryable = rawRetryable
    } catch {
      // ignore property inspection failures
    }

    console.info(
      `[acquisition-message-ingestion-diag] ${JSON.stringify({
        gmailMessageId,
        stage,
        errorName,
        errorCode,
        retryable,
        ...(zodPath !== undefined ? { zodPath } : {}),
        ...(zodIssueCode !== undefined ? { zodIssueCode } : {}),
      })}`
    )
    markMessageIngestionDiagLogged(error)
  } catch {
    // Le diagnostic ne doit jamais provoquer une nouvelle exception.
  }
}

function resolveDiagGmailMessageId(input: RegisterIncomingMessageInput): string {
  try {
    if (input && typeof input === "object" && typeof input.externalMessageId === "string") {
      return input.externalMessageId
    }
  } catch {
    // ignore
  }
  return ""
}

// ─── Normalisation expéditeur (sans décision d’éligibilité) ───────────────────
// Composition root local : wiring défaut Resolver→Repository ici uniquement.
// Le chemin métier n’appelle que PartnerEligibilityResolverPort (voir
// docs/acquisition-partner-registry-cutover.md). Pas de conteneur DI.

export interface NormalizedSender {
  email: string
  domain: string
}

export type RegisterIncomingMessageDeps = {
  /** Injecté en tests ; défaut = resolver registre sur le même `db`. */
  eligibilityResolver?: PartnerEligibilityResolverPort
}

/**
 * Normalise une adresse expéditeur :
 * - accepte la forme « Nom Affiché <adresse@domaine> » (header From) en ne
 *   retenant QUE l'adresse entre chevrons — jamais le nom d'affichage ;
 * - trim + minuscules ;
 * - validation stricte de la forme adresse@domaine ;
 * - extraction du domaine réel (partie après le dernier « @ »).
 *
 * Retourne null si l'adresse est invalide.
 */
export function normalizeSenderAddress(raw: string): NormalizedSender | null {
  if (typeof raw !== "string") return null
  let candidate = raw.trim()

  // Forme « Display Name <addr@domain> » : extraire le contenu des chevrons.
  const angleMatch = candidate.match(/<([^<>]*)>\s*$/)
  if (angleMatch) candidate = angleMatch[1].trim()

  candidate = candidate.toLowerCase()

  // Validation stricte : une seule « partie locale » non vide, un domaine
  // composé d'au moins deux labels alphanumériques (a-z0-9-), sans espaces.
  const emailRegex =
    /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/
  const match = candidate.match(emailRegex)
  if (!match) return null

  return { email: candidate, domain: match[1] }
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
 * - unicité (companyId, source, externalMessageId) : un rappel avec le même
 *   message ne crée aucun doublon (message, brouillon ou pièce jointe) ;
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
  const gmailMessageId = resolveDiagGmailMessageId(input)

  let data
  try {
    data = registerIncomingMessageSchema.parse(input)
  } catch (error) {
    logRegisterIncomingMessageDiag(
      gmailMessageId,
      "REGISTER_INCOMING_MESSAGE_SCHEMA_PARSE",
      error
    )
    throw error
  }

  // Idempotence : si le message existe déjà pour CE tenant, ne rien réécrire.
  let existing
  try {
    existing = await db.acquisitionMessage.findUnique({
      where: {
        companyId_source_externalMessageId: {
          companyId: data.companyId,
          source: data.source,
          externalMessageId: data.externalMessageId,
        },
      },
      include: { draft: { select: { id: true } } },
    })
  } catch (error) {
    logRegisterIncomingMessageDiag(
      data.externalMessageId,
      "REGISTER_INCOMING_MESSAGE_IDEMPOTENCE_LOOKUP",
      error
    )
    throw error
  }
  if (existing)
    return toResult(existing.id, existing.draft?.id ?? null, existing.status, false, existing.lastErrorCode)

  const eligibilityResolver =
    deps.eligibilityResolver ??
    new PartnerEligibilityResolver(new PartnerRegistryRepository(db))

  const normalized = normalizeSenderAddress(data.senderEmail)
  let resolvedPartnerId: string | null = null
  let eligible = false
  if (normalized) {
    try {
      const resolved = await eligibilityResolver.resolveEligibleSender(
        data.companyId,
        normalized.email,
        normalized.domain
      )
      eligible = resolved !== null
      resolvedPartnerId = resolved?.partner.id ?? null
    } catch (error) {
      logRegisterIncomingMessageDiag(
        data.externalMessageId,
        "REGISTER_INCOMING_MESSAGE_ELIGIBILITY_RESOLVE",
        error
      )
      throw error
    }
  }
  const errorCode: "INVALID_SENDER" | "SENDER_NOT_ELIGIBLE" | null =
    normalized === null ? "INVALID_SENDER" : eligible ? null : "SENDER_NOT_ELIGIBLE"

  try {
    const result = await db.$transaction(async (tx) => {
      const message = await tx.acquisitionMessage.create({
        data: {
          companyId: data.companyId,
          source: data.source,
          externalMessageId: data.externalMessageId,
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
          await tx.acquisitionAttachment.createMany({
            data: data.attachments.map((a, index) => ({
              companyId: data.companyId,
              acquisitionMessageId: message.id,
              attachmentKey: buildAttachmentKey(a, index),
              externalAttachmentId: a.externalAttachmentId ?? null,
              filename: a.filename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              category: categorizeAttachment(a.mimeType, a.filename),
              status: "DISCOVERED" as const,
            })),
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

      return { messageId: message.id, draftId, status: message.status }
    })

    return toResult(result.messageId, result.draftId, result.status, true, errorCode)
  } catch (e) {
    // Course concurrente : un autre appel a inséré le même message entre le
    // findUnique et la transaction → relire et répondre de façon idempotente.
    if (isUniqueConstraintError(e)) {
      const raced = await db.acquisitionMessage.findUnique({
        where: {
          companyId_source_externalMessageId: {
            companyId: data.companyId,
            source: data.source,
            externalMessageId: data.externalMessageId,
          },
        },
        include: { draft: { select: { id: true } } },
      })
      if (raced)
        return toResult(raced.id, raced.draft?.id ?? null, raced.status, false, raced.lastErrorCode)
    }
    logRegisterIncomingMessageDiag(
      data.externalMessageId,
      "REGISTER_INCOMING_MESSAGE_TRANSACTION",
      e
    )
    throw e
  }
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
