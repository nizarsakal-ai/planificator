/**
 * PLAN-ACQ-005B — Feature flags & config extraction.
 * OFF par défaut. Prérequis : master + content_fetch.
 * Max attempts / timeout / reclaim TTL via config (jamais magic number seul).
 */

export type ExtractionProviderId = "deterministic" | "anthropic"

export function isAcquisitionExtractionEnabled(): boolean {
  return process.env.ACQUISITION_EXTRACTION_ENABLED === "true"
}

/**
 * PLAN-ACQ-MULTIMODAL — Lecture visuelle (photos, PDF scannés) via blocs natifs
 * Anthropic. OFF par défaut. Sans effet si le provider n'est pas Anthropic.
 * Prérequis : master + extraction (voir acquisition-flag-matrix).
 */
export function isAcquisitionExtractionMultimodalEnabled(): boolean {
  return process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED === "true"
}

export function getExtractionProviderId(): ExtractionProviderId {
  const raw = (process.env.ACQUISITION_EXTRACTION_PROVIDER ?? "deterministic").trim().toLowerCase()
  if (raw === "anthropic") return "anthropic"
  return "deterministic"
}

/** Timeout provider (ms). Défaut 30s, clamp 5s–60s. */
export function getExtractionTimeoutMs(): number {
  const raw = Number(process.env.ACQUISITION_EXTRACTION_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return 30_000
  return Math.min(Math.max(Math.floor(raw), 5_000), 60_000)
}

/** Max tentatives extraction. Défaut 3, clamp 1–10. */
export function getExtractionMaxAttempts(): number {
  const raw = Number(process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS)
  if (!Number.isFinite(raw) || raw <= 0) return 3
  return Math.min(Math.max(Math.floor(raw), 1), 10)
}

/** TTL reclaim EXTRACTING orphelin (ms). Défaut 5 min, clamp 1–30 min. */
export function getExtractionReclaimTtlMs(): number {
  const raw = Number(process.env.ACQUISITION_EXTRACTION_RECLAIM_TTL_MS)
  if (!Number.isFinite(raw) || raw <= 0) return 5 * 60_000
  return Math.min(Math.max(Math.floor(raw), 60_000), 30 * 60_000)
}

export const EXTRACTION_SCHEMA_VERSION = "3" as const
