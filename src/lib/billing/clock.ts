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

/**
 * Horloge de décision (correctifs R3/S3, précisée au cycle R3). À créer AVANT l'acquisition des verrous : `decide()` renvoie
 * l'instant de début de requête (`startedAt`) AVANCÉ du temps réellement écoulé depuis la création de l'horloge (attente du verrou
 * incluse). Ainsi la décision n'est jamais datée d'un instant figé avant l'attente, et un instant de requête simulé (tests, rejeux
 * avec un `now` passé) conserve sa chronologie : le temps écoulé s'ajoute à `startedAt`, il ne le remplace pas par l'heure réelle.
 * Horloge non monotone ⇒ écoulement négatif ignoré (jamais antérieur au début de requête).
 */
export function decisionClock(startedAt: Date, clock?: () => Date): () => Date {
  const read = clock ?? serverNow
  const t0 = read().getTime()
  return () => new Date(startedAt.getTime() + Math.max(0, read().getTime() - t0))
}

export function setBillingClockForTests(clock: (() => Date) | null): void {
  override = clock
}
