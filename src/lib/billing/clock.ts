// ═══════════════════════════════════════════════════════════════════════════
// Horloge serveur contrôlable (correctif R3, revue Codex R2 du 26/10/2026).
// Une décision prise APRÈS l'attente d'un verrou (signature/refus par lien, renvoi d'un devis) compare l'expiration et la validité
// à l'instant où elle est réellement prise, relu via `serverNow()` — jamais à un instant figé au début de la requête.
// En production : horloge réelle. Dans les tests : `setBillingClockForTests` fixe une horloge déterministe (ou une horloge réelle
// pour prouver le passage naturel du temps pendant une attente).
// ═══════════════════════════════════════════════════════════════════════════
let override: (() => Date) | null = null

export function serverNow(): Date {
  return override ? override() : new Date()
}

/** Instant de décision : l'horloge relue après le verrou, jamais antérieure au début de la requête (horloge non monotone). */
export function decisionInstant(startedAt: Date, clock?: () => Date): Date {
  const now = clock ? clock() : serverNow()
  return now.getTime() >= startedAt.getTime() ? now : startedAt
}

export function setBillingClockForTests(clock: (() => Date) | null): void {
  override = clock
}
