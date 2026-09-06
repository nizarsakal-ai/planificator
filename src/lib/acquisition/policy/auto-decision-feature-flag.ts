/**
 * PLAN-ACQ-V2 Lot F — Flags auto-approve / auto-convert.
 */

/** Fallback historique unique pour le seuil de confiance auto / validation. */
export const DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE = 0.75

export function isAcquisitionAutoApproveEnabled(): boolean {
  return process.env.ACQUISITION_AUTO_APPROVE_ENABLED === "true"
}

export function isAcquisitionAutoConvertEnabled(): boolean {
  return process.env.ACQUISITION_AUTO_CONVERT_ENABLED === "true"
}

export function getAcquisitionAutoMinConfidence(): number {
  const raw = process.env.ACQUISITION_AUTO_MIN_CONFIDENCE
  if (raw == null || raw.trim() === "") return DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE
  return Math.round(n * 100) / 100
}

/** User id système pour reviewedBy / createdBy (obligatoire si auto-convert). */
export function getAcquisitionSystemActorUserId(): string | null {
  const id = process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID?.trim()
  return id && id.length > 0 ? id : null
}
