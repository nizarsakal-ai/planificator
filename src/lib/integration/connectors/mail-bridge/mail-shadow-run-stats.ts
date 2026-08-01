/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Compteurs agrégés du run shadow (pas de métriques persistantes).
 */

export type MailShadowRunStats = {
  admitted: number
  skippedBudget: number
  received: number
  duplicate: number
  normalized: number
  normalizeFailed: number
  inconsistent: number
  unexpectedLifecycle: number
  shadowErrors: number
  /** 0 ou 1 — journalisé au plus une fois / company / run. */
  connectionMissingLogged: number
}

export function createMailShadowRunStats(): MailShadowRunStats {
  return {
    admitted: 0,
    skippedBudget: 0,
    received: 0,
    duplicate: 0,
    normalized: 0,
    normalizeFailed: 0,
    inconsistent: 0,
    unexpectedLifecycle: 0,
    shadowErrors: 0,
    connectionMissingLogged: 0,
  }
}
