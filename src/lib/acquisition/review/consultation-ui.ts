/**
 * PLAN-ACQ-005C-MVP — Helpers UI purs (labels, actions, warnings).
 */

import type { WorksiteImportDraftStatus } from "@prisma/client"
import { getExtractionReclaimTtlMs } from "@/lib/acquisition/extraction/extraction-feature-flag"
import {
  EXTRACTION_WARNING_CATALOG,
  EXTRACTION_WARNING_CODES,
} from "@/lib/acquisition/extraction/extraction.schema"

export const CONSULTATION_STATUS_LABELS: Record<WorksiteImportDraftStatus, string> = {
  PENDING_EXTRACTION: "En attente d’extraction",
  EXTRACTING: "Extraction en cours",
  PENDING_REVIEW: "À revoir",
  FAILED: "Échec",
  APPROVED: "Approuvé",
  REJECTED: "Rejeté",
  CONVERTED: "Converti",
  OBSOLETE: "Obsolète",
}

export const CONSULTATION_STATUS_BADGE_CLASS: Record<WorksiteImportDraftStatus, string> = {
  PENDING_EXTRACTION: "bg-slate-100 text-slate-700",
  EXTRACTING: "bg-sky-100 text-sky-800",
  PENDING_REVIEW: "bg-amber-100 text-amber-800",
  FAILED: "bg-red-100 text-red-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-rose-100 text-rose-900",
  CONVERTED: "bg-violet-100 text-violet-800",
  OBSOLETE: "bg-stone-200 text-stone-800",
}

export type ConsultationUiActions = {
  canEdit: boolean
  canSave: boolean
  canApprove: boolean
  canReject: boolean
  canReExtract: boolean
}

/** Politique unique re-extract (actions + UI + tests). */
export type ReExtractPolicy =
  | { allowed: true; force: boolean }
  | { allowed: false }

/**
 * PLAN-ACQ-MULTIMODAL — un EXTRACTING plus vieux que le TTL de reclaim est un
 * orphelin (process interrompu) : la relance manuelle est permise, le claim
 * atomique du service gère déjà la reprise (prédicat extractionStartedAt < TTL).
 * Calcul côté serveur uniquement (env).
 */
export function isExtractingReclaimable(
  status: WorksiteImportDraftStatus,
  extractionStartedAt: Date | string | null | undefined,
  now: Date = new Date()
): boolean {
  if (status !== "EXTRACTING" || !extractionStartedAt) return false
  const started = new Date(extractionStartedAt).getTime()
  if (!Number.isFinite(started)) return false
  return started < now.getTime() - getExtractionReclaimTtlMs()
}

export function getReExtractPolicy(
  status: WorksiteImportDraftStatus,
  opts?: { extractingReclaimable?: boolean }
): ReExtractPolicy {
  switch (status) {
    case "PENDING_EXTRACTION":
    case "FAILED":
      return { allowed: true, force: false }
    case "PENDING_REVIEW":
      return { allowed: true, force: true }
    case "EXTRACTING":
      return opts?.extractingReclaimable === true ? { allowed: true, force: false } : { allowed: false }
    default:
      return { allowed: false }
  }
}

export function getConsultationUiActions(
  status: WorksiteImportDraftStatus,
  opts?: { extractionEnabled?: boolean; extractingReclaimable?: boolean }
): ConsultationUiActions {
  const extractionEnabled = opts?.extractionEnabled !== false
  const reExtract = getReExtractPolicy(status, {
    extractingReclaimable: opts?.extractingReclaimable,
  })
  switch (status) {
    case "PENDING_EXTRACTION":
      return {
        canEdit: false,
        canSave: false,
        canApprove: false,
        canReject: false,
        canReExtract: extractionEnabled && reExtract.allowed,
      }
    case "EXTRACTING":
      return {
        canEdit: false,
        canSave: false,
        canApprove: false,
        canReject: false,
        canReExtract: extractionEnabled && reExtract.allowed,
      }
    case "PENDING_REVIEW":
      return {
        canEdit: true,
        canSave: true,
        canApprove: true,
        canReject: true,
        canReExtract: extractionEnabled && reExtract.allowed,
      }
    case "FAILED":
      return {
        canEdit: true,
        canSave: true,
        canApprove: false,
        canReject: false,
        canReExtract: extractionEnabled && reExtract.allowed,
      }
    case "APPROVED":
    case "REJECTED":
    case "CONVERTED":
    case "OBSOLETE":
    default:
      return {
        canEdit: false,
        canSave: false,
        canApprove: false,
        canReject: false,
        canReExtract: false,
      }
  }
}

export function truncateSubject(subject: string, max = 120): string {
  const t = subject.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

export function formatConfidencePercent(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1) return null
  return `${Math.round(n * 100)} %`
}

function isWarningCode(code: string): code is (typeof EXTRACTION_WARNING_CODES)[number] {
  return (EXTRACTION_WARNING_CODES as readonly string[]).includes(code)
}

export type PublicWarningView = {
  code: string
  severity: string
  field?: string
  blocking: boolean
  message: string
}

/** Message public catalogue uniquement — jamais de raw provider. */
export function mapWarningDataToPublicView(raw: unknown): PublicWarningView[] {
  if (!Array.isArray(raw)) return []
  const out: PublicWarningView[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const code = String((item as { code?: unknown }).code ?? "")
    if (!code) continue
    const fieldRaw = (item as { field?: unknown }).field
    const field = typeof fieldRaw === "string" && fieldRaw.trim() ? fieldRaw.trim() : undefined
    const rawBlocking = (item as { blocking?: unknown }).blocking === true
    if (isWarningCode(code)) {
      const cat = EXTRACTION_WARNING_CATALOG[code]
      out.push({
        code,
        severity: cat.severity,
        field,
        blocking: rawBlocking || cat.blocking,
        message: cat.message,
      })
    } else {
      out.push({
        code: "UNKNOWN_WARNING",
        severity: "WARNING",
        field,
        blocking: rawBlocking,
        message: "Avertissement non catalogue",
      })
    }
  }
  return out
}

/**
 * Approuve bloquée si un warning structuré a `blocking === true`,
 * même hors catalogue UI.
 */
export function hasBlockingWarnings(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    if ((item as { blocking?: unknown }).blocking === true) return true
  }
  return false
}

export function dateToInputValue(d: Date | null | undefined): string {
  if (!d) return ""
  const iso = new Date(d).toISOString()
  return iso.slice(0, 10)
}

/**
 * PLAN-ACQ-MULTIMODAL — Issue de lecture d'une pièce jointe lors de la dernière
 * extraction (source : extractedData.attachmentReadOutcomes). Codes fermés ;
 * aucun texte issu du fichier n'est affiché hormis le nom de fichier.
 */
export type AttachmentReadingTone = "ok" | "muted" | "warn" | "error"

export type AttachmentReadingView = {
  /** Id de pièce (association fiable ; noms homonymes possibles). */
  attachmentId?: string
  filename: string
  outcome: string
  label: string
  tone: AttachmentReadingTone
}

const ATTACHMENT_READING_LABELS: Record<string, { label: string; tone: AttachmentReadingTone }> = {
  READ_TEXT: { label: "Lu (texte)", tone: "ok" },
  READ_TEXT_TRUNCATED: { label: "Lu (texte, tronqué)", tone: "ok" },
  READ_VISION: { label: "Lu (vision)", tone: "ok" },
  IGNORED_FORMAT: { label: "Ignoré : format non pris en charge", tone: "muted" },
  IGNORED_TOO_LARGE: { label: "Ignoré : trop gros", tone: "warn" },
  IGNORED_HEIC: { label: "Ignoré : photo HEIC (demander un JPEG)", tone: "warn" },
  IGNORED_VISION_DISABLED: { label: "Ignoré : lecture visuelle désactivée", tone: "muted" },
  IGNORED_EMPTY: { label: "Ignoré : aucune donnée", tone: "muted" },
  UNAVAILABLE: { label: "Non lu : pièce non téléchargée", tone: "warn" },
  FAILED: { label: "Échec de lecture", tone: "error" },
}

const READING_REASON_SUFFIX: Record<string, string> = {
  FLAG_OFF: "flag OFF",
  PROVIDER_NOT_VISION: "fournisseur sans vision",
  MAX_VISUAL_FILES: "plus de 5 fichiers visuels",
  VISUAL_FILE_BYTES: "> 5 Mo",
  VISUAL_TOTAL_BUDGET: "budget visuel dépassé",
  PDF_PAGES: "> 10 pages",
  IMAGE_DIMENSIONS: "> 8000 px",
  FILE_BYTES: "> 10 Mo",
  TEXT_BUDGET: "budget texte atteint",
  XLSX_FLAG_OFF: "lecture .xlsx désactivée (flag)",
  DEADLINE: "délai dépassé",
  PROVIDER_REJECTED: "refusée par le fournisseur",
  XLSX_LIMITS: "classeur trop volumineux",
  LOAD_BUDGET: "trop de pièces volumineuses",
}

export const ATTACHMENT_READING_TONE_CLASS: Record<AttachmentReadingTone, string> = {
  ok: "bg-green-100 text-green-800",
  muted: "bg-slate-100 text-slate-700",
  warn: "bg-amber-100 text-amber-800",
  error: "bg-red-100 text-red-800",
}

export function mapAttachmentReadOutcomes(extractedData: unknown): AttachmentReadingView[] {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return []
  const raw = (extractedData as { attachmentReadOutcomes?: unknown }).attachmentReadOutcomes
  if (!Array.isArray(raw)) return []
  const out: AttachmentReadingView[] = []
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const filename = (item as { filename?: unknown }).filename
    const outcome = (item as { outcome?: unknown }).outcome
    if (typeof filename !== "string" || typeof outcome !== "string") continue
    const cat = ATTACHMENT_READING_LABELS[outcome]
    if (!cat) continue
    const reasonRaw = (item as { reason?: unknown }).reason
    const suffix = typeof reasonRaw === "string" ? READING_REASON_SUFFIX[reasonRaw] : undefined
    const idRaw = (item as { attachmentId?: unknown }).attachmentId
    out.push({
      ...(typeof idRaw === "string" && idRaw ? { attachmentId: idRaw.slice(0, 64) } : {}),
      filename: filename.slice(0, 255),
      outcome,
      label: suffix ? `${cat.label} (${suffix})` : cat.label,
      tone: cat.tone,
    })
  }
  return out
}
