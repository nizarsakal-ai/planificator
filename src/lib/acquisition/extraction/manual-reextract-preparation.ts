/**
 * PLAN-ACQ-MULTIMODAL — Relance manuelle autonome (« Relancer l'extraction »).
 *
 * Avant d'extraire, récupère ce qui manque pour CE message uniquement :
 * 1. texte du mail absent + flag content fetch ON → fetchAndStoreMessageContentCore
 * 2. pièces DISCOVERED (ou FAILED retryables échues) + flag download ON →
 *    downloadAcquisitionAttachment (mêmes garde-fous : flags, claim atomique
 *    DISCOVERED→PENDING_DOWNLOAD, validation MIME/signature/taille, retry
 *    policy allowlist + backoff + maxRetries).
 * Échecs non bloquants → avertissements lisibles. Flags OFF → comportement
 * historique + message clair. Bornes : 10 téléchargements, budget temps.
 *
 * Appelé uniquement après AuthZ ADMIN|SUPER_ADMIN ; companyId = session.
 */

import { prisma } from "@/lib/prisma"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { isAcquisitionContentFetchEnabled } from "@/lib/acquisition/content/content-fetch-feature-flag"
import { fetchAndStoreMessageContentCore } from "@/lib/acquisition/content/message-content.service"
import type { FetchMessageContentResult } from "@/lib/acquisition/content/message-content.types"
import { isAttachmentDownloadEnabled } from "@/lib/acquisition/attachments/attachment-policy"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import {
  RETRYABLE_ATTACHMENT_ERROR_CODES,
  isRetryableAttachmentErrorCode,
} from "@/lib/acquisition/attachments/attachment-retry.policy"
import { getAttachmentRecoveryCronConfig } from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"
import type {
  AttachmentDownloadResult,
  ScheduleRetryToDiscoveredResult,
} from "@/lib/acquisition/attachments/attachment.types"
import { hasExploitableMessageText } from "@/lib/acquisition/extraction/extraction-source-fingerprint"

export const MANUAL_REEXTRACT_MAX_DOWNLOADS = 10
/** Au-delà, plus de nouveau téléchargement (le cron prendra le relais). */
export const MANUAL_REEXTRACT_DOWNLOAD_BUDGET_MS = 20_000
/** Temps réservé à l'extraction après la préparation (lecture PJ + provider). */
export const MANUAL_REEXTRACT_EXTRACTION_RESERVE_MS = 90_000

export const CONTENT_FETCH_DISABLED_WARNING = "Récupération du contenu désactivée (flag)"
export const ATTACHMENT_DOWNLOAD_DISABLED_WARNING = "Téléchargement des pièces jointes désactivé (flag)"

export type ManualReExtractAttachmentRow = {
  id: string
  filename: string
  status: string
  lastErrorCode: string | null
}

export type ManualReExtractPreparation = {
  warnings: string[]
  contentFetched: boolean
  attachmentsStored: number
}

export type ManualReExtractPreparationDeps = {
  isAcquisitionEnabled?: () => boolean
  isContentFetchEnabled?: () => boolean
  isAttachmentDownloadEnabled?: () => boolean
  findDraftMessageId?: (companyId: string, draftId: string) => Promise<string | null>
  findContent?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<{ normalizedText: string } | null>
  fetchContent?: (input: {
    companyId: string
    acquisitionMessageId: string
    logActorId?: string
  }) => Promise<FetchMessageContentResult>
  listAttachments?: (
    companyId: string,
    acquisitionMessageId: string
  ) => Promise<ManualReExtractAttachmentRow[]>
  scheduleRetryToDiscovered?: (input: {
    companyId: string
    attachmentId: string
    now: Date
    maxRetries: number
    retryableErrorCodes: string[]
  }) => Promise<ScheduleRetryToDiscoveredResult>
  downloadAttachment?: (input: {
    companyId: string
    attachmentId: string
  }) => Promise<AttachmentDownloadResult>
  now?: () => Date
  clock?: () => number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`[acquisition-reextract-prepare] ${event}`, payload)
  else console.log(`[acquisition-reextract-prepare] ${event}`)
}

function label(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean || "pièce jointe"
}

const defaultDeps: Required<
  Pick<
    ManualReExtractPreparationDeps,
    "findDraftMessageId" | "findContent" | "listAttachments"
  >
> = {
  async findDraftMessageId(companyId, draftId) {
    const row = await prisma.worksiteImportDraft.findFirst({
      where: { id: draftId, companyId },
      select: { acquisitionMessageId: true },
    })
    return row?.acquisitionMessageId ?? null
  },
  async findContent(companyId, acquisitionMessageId) {
    return prisma.acquisitionMessageContent.findFirst({
      where: { companyId, acquisitionMessageId },
      select: { normalizedText: true },
    })
  },
  async listAttachments(companyId, acquisitionMessageId) {
    return prisma.acquisitionAttachment.findMany({
      where: { companyId, acquisitionMessageId },
      select: { id: true, filename: true, status: true, lastErrorCode: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    })
  },
}

function contentFailureWarning(result: Extract<FetchMessageContentResult, { ok: false }>): string {
  if (result.code === "CONTENT_EMPTY") {
    return "Le mail ne contient pas de texte exploitable : extraction sur les pièces jointes"
  }
  return `Contenu du mail non récupéré : ${result.message}`
}

export async function prepareManualReExtraction(
  input: { companyId: string; draftId: string; actorUserId?: string; deadlineAt?: number },
  deps: ManualReExtractPreparationDeps = {}
): Promise<ManualReExtractPreparation> {
  const out: ManualReExtractPreparation = { warnings: [], contentFetched: false, attachmentsStored: 0 }
  const log = deps.log ?? defaultLog
  const masterOn = (deps.isAcquisitionEnabled ?? isAcquisitionEnabled)()
  if (!masterOn) return out

  // L'extraction elle-même exige le content fetch : flag OFF ⇒ rien à préparer.
  if (!(deps.isContentFetchEnabled ?? isAcquisitionContentFetchEnabled)()) {
    out.warnings.push(CONTENT_FETCH_DISABLED_WARNING)
    return out
  }

  const findDraftMessageId = deps.findDraftMessageId ?? defaultDeps.findDraftMessageId
  const messageId = await findDraftMessageId(input.companyId, input.draftId)
  if (!messageId) return out

  // 1) Texte du mail.
  const findContent = deps.findContent ?? defaultDeps.findContent
  const content = await findContent(input.companyId, messageId)
  if (!hasExploitableMessageText(content)) {
    if (
      input.deadlineAt != null &&
      (deps.clock ?? Date.now)() >= input.deadlineAt - MANUAL_REEXTRACT_EXTRACTION_RESERVE_MS
    ) {
      out.warnings.push("Délai de relance atteint : contenu du mail non récupéré")
      return out
    }
    const fetchContent = deps.fetchContent ?? fetchAndStoreMessageContentCore
    try {
      const r = await fetchContent({
        companyId: input.companyId,
        acquisitionMessageId: messageId,
        logActorId: input.actorUserId,
      })
      if (r.ok) {
        out.contentFetched = true
      } else {
        out.warnings.push(contentFailureWarning(r))
      }
    } catch {
      out.warnings.push("Contenu du mail non récupéré : erreur inattendue")
    }
  }

  // 2) Pièces jointes manquantes.
  const listAttachments = deps.listAttachments ?? defaultDeps.listAttachments
  const attachments = await listAttachments(input.companyId, messageId)
  const pending = attachments.filter(
    (a) =>
      a.status === "DISCOVERED" ||
      (a.status === "FAILED" && isRetryableAttachmentErrorCode(a.lastErrorCode))
  )
  if (pending.length === 0) return out

  if (!(deps.isAttachmentDownloadEnabled ?? isAttachmentDownloadEnabled)()) {
    out.warnings.push(
      `${ATTACHMENT_DOWNLOAD_DISABLED_WARNING} : ${pending.length} pièce(s) non récupérée(s)`
    )
    return out
  }

  const now = (deps.now ?? (() => new Date()))()
  const clock = deps.clock ?? Date.now
  const started = clock()
  // Échéance de téléchargement : 20 s ET réserve pour l'extraction avant l'échéance globale.
  const downloadUntil = Math.min(
    started + MANUAL_REEXTRACT_DOWNLOAD_BUDGET_MS,
    (input.deadlineAt ?? Number.POSITIVE_INFINITY) - MANUAL_REEXTRACT_EXTRACTION_RESERVE_MS
  )
  const schedule =
    deps.scheduleRetryToDiscovered ??
    ((i) => acquisitionAttachmentRepository.scheduleRetryToDiscovered(i))
  const download = deps.downloadAttachment ?? ((i) => downloadAcquisitionAttachment(i))
  const { maxRetries } = getAttachmentRecoveryCronConfig()

  let attempted = 0
  for (let i = 0; i < pending.length; i++) {
    const att = pending[i]
    if (attempted >= MANUAL_REEXTRACT_MAX_DOWNLOADS || clock() >= downloadUntil) {
      const left = pending.length - i
      out.warnings.push(`${left} pièce(s) restante(s) seront récupérées par la tâche planifiée`)
      break
    }
    try {
      if (att.status === "FAILED") {
        // Mêmes bornes que la récupération planifiée : codes retryables,
        // maxRetries et échéance de backoff respectés (pas de contournement).
        const t = await schedule({
          companyId: input.companyId,
          attachmentId: att.id,
          now,
          maxRetries,
          retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
        })
        if (t !== "TRANSITIONED") {
          out.warnings.push(`Pièce « ${label(att.filename)} » : nouvel essai prévu plus tard`)
          continue
        }
      }
      attempted++
      const r = await download({ companyId: input.companyId, attachmentId: att.id })
      if (r.outcome === "STORED" || r.outcome === "ALREADY_STORED") {
        out.attachmentsStored++
      } else if (r.outcome === "ALREADY_IN_PROGRESS") {
        out.warnings.push(`Pièce « ${label(att.filename)} » : téléchargement déjà en cours`)
      } else {
        out.warnings.push(
          `Pièce « ${label(att.filename)} » non récupérée (${r.errorCode ?? r.outcome})`
        )
      }
    } catch {
      out.warnings.push(`Pièce « ${label(att.filename)} » non récupérée (erreur inattendue)`)
    }
  }

  log("PREPARED", {
    draftId: input.draftId,
    contentFetched: out.contentFetched,
    attachmentsStored: out.attachmentsStored,
    warningCount: out.warnings.length,
  })
  return out
}
