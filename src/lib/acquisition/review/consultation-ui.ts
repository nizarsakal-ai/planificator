/**
 * PLAN-ACQ-005C-MVP — Helpers UI purs (labels, actions, warnings).
 */

import type { WorksiteImportDraftStatus } from "@prisma/client"
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
}

export const CONSULTATION_STATUS_BADGE_CLASS: Record<WorksiteImportDraftStatus, string> = {
  PENDING_EXTRACTION: "bg-slate-100 text-slate-700",
  EXTRACTING: "bg-sky-100 text-sky-800",
  PENDING_REVIEW: "bg-amber-100 text-amber-800",
  FAILED: "bg-red-100 text-red-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-rose-100 text-rose-900",
  CONVERTED: "bg-violet-100 text-violet-800",
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

export function getReExtractPolicy(status: WorksiteImportDraftStatus): ReExtractPolicy {
  switch (status) {
    case "PENDING_EXTRACTION":
    case "FAILED":
      return { allowed: true, force: false }
    case "PENDING_REVIEW":
      return { allowed: true, force: true }
    default:
      return { allowed: false }
  }
}

export function getConsultationUiActions(
  status: WorksiteImportDraftStatus,
  opts?: { extractionEnabled?: boolean }
): ConsultationUiActions {
  const extractionEnabled = opts?.extractionEnabled !== false
  const reExtract = getReExtractPolicy(status)
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
        canReExtract: false,
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
