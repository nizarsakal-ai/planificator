/**
 * Lot D Planificator V2 : limite de débit de la recherche (horloge injectée, aucune attente réelle).
 * Portée vérifiée : PAR INSTANCE (un limiteur par processus) ; clé = (société, utilisateur) ; 429 au-delà du seuil ;
 * récupération quand la fenêtre glisse ; mémoire bornée ; une clé évincée repart avec une fenêtre vide (documenté).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { SEARCH_RATE_LIMIT, SEARCH_RATE_MAX_KEYS, SEARCH_RATE_WINDOW_MS, createRateLimiter, searchRateLimiter } from "@/lib/search/search-rate-limit"

describe("limite de débit de la recherche", () => {
  it("valeurs annoncées : 30 requêtes par minute, 10 000 couples au plus", () => {
    assert.deepEqual([SEARCH_RATE_LIMIT, SEARCH_RATE_WINDOW_MS, SEARCH_RATE_MAX_KEYS], [30, 60_000, 10_000])
  })
  it("30 requêtes admises dans la minute ; la 31e refusée avec un délai ; récupération quand la fenêtre glisse", () => {
    const l = createRateLimiter()
    const t0 = 1_000_000
    for (let i = 0; i < 30; i++) {
      const d = l.check("co1", "u1", t0 + i * 100)
      assert.deepEqual(d, { allowed: true, remaining: 29 - i }, `requête ${i + 1}`)
    }
    const refused = l.check("co1", "u1", t0 + 3_000)
    assert.equal(refused.allowed, false)
    if (!refused.allowed) assert.equal(refused.retryAfterSeconds, 57, "la première requête sort de la fenêtre à t0 + 60 s")
    assert.equal(l.check("co1", "u1", t0 + 59_999).allowed, false, "toujours dans la fenêtre")
    assert.deepEqual(l.check("co1", "u1", t0 + 60_001), { allowed: true, remaining: 0 }, "une place libérée")
    assert.equal(l.check("co1", "u1", t0 + 60_002).allowed, false)
    assert.deepEqual(l.check("co1", "u1", t0 + 200_000), { allowed: true, remaining: 29 }, "fenêtre entièrement écoulée")
  })
  it("un refus ne consomme pas de place ; clés indépendantes par utilisateur ET par société", () => {
    const l = createRateLimiter({ limit: 2, windowMs: 1_000 })
    assert.equal(l.check("co1", "u1", 0).allowed, true)
    assert.equal(l.check("co1", "u1", 1).allowed, true)
    for (let i = 0; i < 5; i++) assert.equal(l.check("co1", "u1", 2 + i).allowed, false)
    assert.equal(l.check("co1", "u1", 1_001).allowed, true, "les refus n'ont pas prolongé la fenêtre")
    assert.equal(l.check("co1", "u2", 2).allowed, true, "autre utilisateur")
    assert.equal(l.check("co2", "u1", 2).allowed, true, "même utilisateur, autre société")
  })
  it("mémoire bornée : au-delà de la borne, les clés les moins récemment actives sont évincées et repartent d'une fenêtre vide", () => {
    const l = createRateLimiter({ limit: 1, windowMs: 1_000_000, maxKeys: 3 })
    for (const u of ["a", "b", "c"]) assert.equal(l.check("co", u, 0).allowed, true)
    assert.equal(l.check("co", "a", 1).allowed, false, "a est limité")
    assert.equal(l.check("co", "d", 2).allowed, true)
    assert.ok(l.size() <= 3, `taille ${l.size()}`)
    assert.equal(l.check("co", "b", 3).allowed, true, "b, évincée (la moins récemment active), repart avec une fenêtre vide : limite relâchée, documentée")
  })
  it("portée explicite dans le code : par instance, pas une garantie globale ; limiteur unique du processus", () => {
    const src = readFileSync("src/lib/search/search-rate-limit.ts", "utf8")
    assert.match(src, /PAR INSTANCE serveur/)
    assert.match(src, /PAS une garantie\s+\*?\s*globale/)
    assert.match(src, /REPART AVEC UNE FENÊTRE VIDE/)
    assert.doesNotMatch(src, /une requête de plus/)
    assert.equal(typeof searchRateLimiter.check, "function")
  })
})
