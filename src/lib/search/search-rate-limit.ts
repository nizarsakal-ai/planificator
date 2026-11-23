/**
 * Lot D Planificator V2 : limite de débit de la recherche globale.
 *
 * PORTÉE (explicite) : compteur EN MÉMOIRE, PAR INSTANCE serveur. C'est une réduction de charge, PAS une garantie
 * globale : avec N instances, un utilisateur peut atteindre N × la limite (davantage encore en cas d'éviction, voir
 * ci-dessous). Aucun service ni table ajoutés.
 *
 * Règle : au plus `LIMIT` requêtes par fenêtre glissante de `WINDOW_MS`, par couple (société, utilisateur) issu de la
 * session serveur (jamais d'une donnée du client). Le contrôle est fait AVANT toute requête en base. Mémoire bornée :
 * au plus `MAX_KEYS` couples suivis ; les entrées expirées sont purgées et, au-delà de la borne, les moins récemment
 * actives sont évincées. Une clé évincée REPART AVEC UNE FENÊTRE VIDE : elle peut de nouveau émettre jusqu'à `LIMIT`
 * requêtes. L'éviction ne refuse donc jamais une requête à tort, mais elle relâche la limite pour cette clé ; elle ne
 * survient qu'au-delà de `MAX_KEYS` couples actifs dans la même fenêtre sur une instance.
 */
export const SEARCH_RATE_LIMIT = 30
export const SEARCH_RATE_WINDOW_MS = 60_000
export const SEARCH_RATE_MAX_KEYS = 10_000

export type RateDecision = { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number }

export interface RateLimiter {
  check(companyId: string, userId: string, nowMs?: number): RateDecision
  size(): number
}

export function createRateLimiter(opts: { limit?: number; windowMs?: number; maxKeys?: number } = {}): RateLimiter {
  const limit = opts.limit ?? SEARCH_RATE_LIMIT
  const windowMs = opts.windowMs ?? SEARCH_RATE_WINDOW_MS
  const maxKeys = opts.maxKeys ?? SEARCH_RATE_MAX_KEYS
  // Map = ordre d'insertion : la première clé est la moins récemment ACTIVE (réinsérée à chaque accès).
  const hits = new Map<string, number[]>()

  function prune(nowMs: number) {
    for (const [k, times] of hits) {
      if (times.length === 0 || times[times.length - 1] <= nowMs - windowMs) hits.delete(k)
    }
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value
      if (oldest === undefined) break
      hits.delete(oldest)
    }
  }

  return {
    check(companyId, userId, nowMs = Date.now()) {
      const key = `${companyId}\u0000${userId}`
      const recent = (hits.get(key) ?? []).filter((t) => t > nowMs - windowMs)
      hits.delete(key)
      if (recent.length >= limit) {
        hits.set(key, recent)
        const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - nowMs) / 1000))
        return { allowed: false, retryAfterSeconds }
      }
      recent.push(nowMs)
      hits.set(key, recent)
      if (hits.size > maxKeys) prune(nowMs)
      return { allowed: true, remaining: limit - recent.length }
    },
    size: () => hits.size,
  }
}

/** Limiteur partagé du processus (une instance serveur). */
export const searchRateLimiter: RateLimiter = createRateLimiter()
