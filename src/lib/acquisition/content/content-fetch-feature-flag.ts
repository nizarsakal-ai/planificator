/**
 * PLAN-ACQ-005A — Feature flag fetch contenu email.
 * OFF par défaut. Prérequis : PLANIFICATOR_ACQUISITION_ENABLED=true.
 */
export function isAcquisitionContentFetchEnabled(): boolean {
  return process.env.ACQUISITION_CONTENT_FETCH_ENABLED === "true"
}

/** Plafond octets bruts (text/plain + text/html) avant sanitize. */
export function getContentFetchMaxRawBytes(): number {
  const raw = Number(process.env.ACQUISITION_CONTENT_MAX_RAW_BYTES)
  if (!Number.isFinite(raw) || raw <= 0) return 512 * 1024
  return Math.min(Math.floor(raw), 2 * 1024 * 1024)
}

/**
 * Plafond octets UTF-8 du texte normalisé final.
 * Dépassement → refus ACQUISITION_CONTENT_TOO_LARGE (jamais de troncature).
 */
export function getContentNormalizedMaxBytes(): number {
  const raw = Number(process.env.ACQUISITION_CONTENT_NORMALIZED_MAX_BYTES)
  if (!Number.isFinite(raw) || raw <= 0) return 64 * 1024
  return Math.min(Math.floor(raw), 256 * 1024)
}

/** Préfixe de hash sûr pour logs / réponses POST (jamais le hash complet en logs). */
export function contentHashPrefix(contentHash: string, length = 8): string {
  if (!contentHash) return ""
  return contentHash.slice(0, Math.max(1, Math.min(length, contentHash.length)))
}
