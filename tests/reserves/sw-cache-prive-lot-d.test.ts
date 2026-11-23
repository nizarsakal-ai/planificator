// Lot D — cache du service worker (preuves R18c : preuve et PDF de PV chargés sous A, resservis hors ligne depuis le cache « pages »
// à B et au rôle refusé). Contenus SYNTHÉTIQUES uniquement. Vérifie :
//  1. intégration sur main 743c5ec2 (23/11) : politique PWA STRICTEMENT STATIQUE de main (PWA_STATIC_RUNTIME_CACHING) ; aucune
//     route D n'est interceptée par le SW ; aucune règle NetworkOnly artificielle ni purgeur historique (sw-purge-lot-d.js retiré) ;
//  2. la garde À LA SOURCE (src/lib/reserves/garde-cache-sw.ts, appelée en tête d'authorizedCallback) refuse la lecture d'une
//     page D par le worker du cache de navigation front-end de next-pwa (référent = son script), quel que soit le moment de
//     l'écriture, sans toucher aux fetch de page (harnais compris), navigations, flux RSC, actions serveur, fichiers D ni autres modules ;
//  3. les caches où R18c a observé des entrées D figurent dans LEGACY_PRIVATE_CACHES de main ; sa purge (page et activation du SW,
//     src/worker) ne laisse, « même profil », aucune entrée D de même origine ni pièce ou PDF de A ; précache intact ;
//  4. le matcher d'authentification de main est inchangé : fichiers du SW publics, aucune exclusion ajoutée, routes D authentifiées.
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { authorizedCallback } from "@/auth.config"
import { estPagePriveeLotD, refusLecturePageLotDParCacheDeNavigation } from "@/lib/reserves/garde-cache-sw"
import { PWA_STATIC_RUNTIME_CACHING } from "../../next.config"
import { LEGACY_PRIVATE_CACHES, purgeLegacyPrivateCaches } from "../../src/components/ServiceWorkerUpdater"
import { config as middlewareConfig } from "../../src/middleware"

const RACINE = fileURLToPath(new URL("../..", import.meta.url))
const ORIGINE = "http://localhost:3214"

type Regle = (typeof PWA_STATIC_RUNTIME_CACHING)[number]
const captee = (chemin: string, origine = ORIGINE) => {
  const url = new URL(chemin, origine), sameOrigin = url.origin === ORIGINE
  return PWA_STATIC_RUNTIME_CACHING.some((r: Regle) => r.urlPattern instanceof RegExp ? r.urlPattern.test(url.href) : r.urlPattern({ url, sameOrigin }))
}

describe("SW lot D : politique statique de main (next.config.ts), aucune capture des routes D", () => {
  it("routes privées D (pages, flux RSC, pièces, PDF de PV, indicateurs, recherche) : jamais interceptées par le SW", () => {
    for (const p of ["/reserves", "/reserves/d1-w-a2", "/reserves/fichiers/f-synthetique", "/reserves/pv/pv-synthetique/pdf",
      "/reserves/chantier", "/reserves/d1-w-a7?_rsc=abc", "/tableaux-de-bord", "/tableaux-de-bord/x", "/api/recherche?q=Synthetique", "/api/recherche/x"])
      assert.equal(captee(p), false, p)
    assert.equal(captee("/reserves/fichiers/f-synthetique", "https://autre.example"), false)
  })
  it("aucune règle NetworkOnly artificielle ni purgeur historique : seule la liste statique de main", () => {
    const source = readFileSync(path.join(RACINE, "next.config.ts"), "utf8")
    assert.ok(source.includes("runtimeCaching: PWA_STATIC_RUNTIME_CACHING"))
    assert.doesNotMatch(source, /NetworkOnly|sw-purge-lot-d|importScripts/)
    assert.equal(existsSync(path.join(RACINE, "public/sw-purge-lot-d.js")), false, "ancien purgeur retiré")
  })
})

// ── Garde à la source ──
type Req = { nextUrl: URL; method?: string; headers?: Headers }
const requete = (chemin: string, entetes: Record<string, string>, method = "GET"): Req =>
  ({ nextUrl: new URL(chemin, ORIGINE), method, headers: new Headers(entetes) })
// fetch() du worker dédié de next-pwa : référent = URL de son script.
const SWE = { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", referer: `${ORIGINE}/swe-worker-5c72df51bb1f6ee0.js` }
// fetch() émis par une page (harnais : invalidation de session, témoin de transport) : référent = la page.
const PAGE = { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", referer: `${ORIGINE}/reserves` }
const DOCUMENT = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", referer: `${ORIGINE}/dashboard` }
const RSC = { "sec-fetch-dest": "empty", rsc: "1", "next-router-state-tree": "x", referer: `${ORIGINE}/swe-worker-5c72df51bb1f6ee0.js` }
const RSC_PREFETCH = { ...RSC, "next-router-prefetch": "1" }

describe("SW lot D : garde à la source (lecture d'une page D par le cache de navigation front-end)", () => {
  it("pages D seulement : /reserves, /reserves/<chantier>, /tableaux-de-bord", () => {
    for (const p of ["/reserves", "/reserves/d1-w-a2", "/tableaux-de-bord"]) assert.equal(estPagePriveeLotD(p), true, p)
    for (const p of ["/reserves/chantier", "/reserves/fichiers/f", "/reserves/pv/p/pdf", "/reservesx", "/tableaux-de-bord/x", "/dashboard", "/vehicules", "/api/recherche"])
      assert.equal(estPagePriveeLotD(p), false, p)
  })

  it("fetch du worker swe-worker vers une page D : 403 sans corps, no-store (avec ou sans Sec-Fetch-Dest)", async () => {
    const sansMeta = { referer: SWE.referer }
    for (const p of ["/reserves", "/reserves/d1-w-a2", "/tableaux-de-bord"]) for (const h of [SWE, sansMeta]) {
      const r = refusLecturePageLotDParCacheDeNavigation(requete(p, h))
      assert.ok(r, p); assert.equal(r.status, 403); assert.equal(r.ok, false)
      assert.equal(r.headers.get("cache-control"), "no-store"); assert.equal(await r.text(), "")
    }
  })

  it("aucun effet sur fetch de page, navigations, flux RSC, préchargements, actions serveur, fichiers D, autres modules", () => {
    const aucun = (p: string, h: Record<string, string>, m = "GET") => assert.equal(refusLecturePageLotDParCacheDeNavigation(requete(p, h, m)), null, `${m} ${p} ${JSON.stringify(h)}`)
    aucun("/reserves", PAGE); aucun("/reserves?temoin-reseau=x", PAGE); aucun("/reserves/d1-w-a2", DOCUMENT)
    aucun("/reserves/d1-w-a2", RSC); aucun("/reserves", RSC_PREFETCH); aucun("/reserves", { ...SWE, "next-action": "a" }, "POST")
    aucun("/reserves", { ...SWE, "sec-fetch-dest": "document" })
    aucun("/reserves", { ...SWE, referer: "https://autre.example/swe-worker-5c72df51bb1f6ee0.js" })
    aucun("/reserves", { ...SWE, referer: `${ORIGINE}/swe-worker-5c72df51bb1f6ee0.js.map` })
    for (const p of ["/reserves/fichiers/f", "/reserves/pv/p/pdf", "/reserves/chantier?id=w", "/dashboard", "/vehicules", "/chantiers"]) aucun(p, SWE)
    assert.equal(refusLecturePageLotDParCacheDeNavigation({ nextUrl: new URL("/reserves", ORIGINE) }), null)
  })

  it("authorizedCallback : refus du worker avant toute autre règle ; sonde d'invalidation et témoin de transport du harnais inchangés", () => {
    const admin = { user: { role: "ADMIN" } }
    for (const auth of [admin, null]) {
      const r = authorizedCallback({ auth, request: requete("/reserves/d1-w-a2", SWE) })
      assert.ok(r instanceof Response); assert.equal(r.status, 403); assert.equal(r.headers.get("location"), null)
    }
    assert.equal(authorizedCallback({ auth: null, request: requete("/reserves", PAGE) }), false)   // après déconnexion : redirection vers /login
    assert.equal(authorizedCallback({ auth: admin, request: requete("/reserves?temoin-reseau=x", PAGE) }), true)   // témoin de transport
    assert.equal(authorizedCallback({ auth: admin, request: requete("/reserves/d1-w-a2", DOCUMENT) }), true)
    assert.equal(authorizedCallback({ auth: null, request: requete("/reserves/d1-w-a2", DOCUMENT) }), false)
    assert.equal(authorizedCallback({ auth: admin, request: requete("/dashboard", SWE) }), true)
    assert.equal(authorizedCallback({ auth: null, request: { nextUrl: new URL("/reserves", ORIGINE) } }), false)
  })

  it("même profil : le cache de navigation front-end (logique de next-pwa 10.2.9) n'écrit aucune page D, quel que soit le délai", async () => {
    const pages = new Map<string, string>()
    // Serveur synthétique : garde + décision d'accès, puis page privée de A.
    const serveur = async (chemin: string, entetes: Record<string, string>) => {
      const d = authorizedCallback({ auth: { user: { role: "ADMIN" } }, request: requete(chemin, entetes) })
      if (d instanceof Response) return d
      return new Response(d ? `PAGE-SYNTHETIQUE-DE-A ${chemin}` : "", { status: d ? 200 : 307 })
    }
    // Reproduction du traitement __FRONTEND_NAV_CACHE__ : déjà en cache → rien ; fetch ; !ok → rien ; sinon écriture (différée).
    const cacheDeNavigation = async (chemin: string, delaiMs: number) => {
      if (pages.has(chemin)) return
      const s = await serveur(chemin, SWE)
      if (!s.ok) return
      await new Promise((r) => setTimeout(r, delaiMs))
      pages.set(chemin, await s.text())
    }
    await Promise.all([cacheDeNavigation("/reserves/d1-w-a2", 0), cacheDeNavigation("/reserves", 20), cacheDeNavigation("/tableaux-de-bord", 40),
      cacheDeNavigation("/dashboard", 10)])
    assert.deepEqual([...pages.keys()], ["/dashboard"])
  })
})

// ── Anciens caches privés (main : LEGACY_PRIVATE_CACHES, purgés côté page et à l'activation du SW) : CacheStorage en mémoire ──
type Entree = { url: string; corps: string }
class CacheSimule {
  entrees = new Map<string, Entree>()
  async keys() { return [...this.entrees.values()].map((e) => ({ url: e.url })) }
  async delete(r: { url: string }) { return this.entrees.delete(r.url) }
  async match(url: string) { return this.entrees.get(url) }
  put(url: string, corps: string) { this.entrees.set(url, { url, corps }) }
}
class StockageSimule {
  caches = new Map<string, CacheSimule>()
  async keys() { return [...this.caches.keys()] }
  async delete(nom: string) { return this.caches.delete(nom) }
  inventaire() { return [...this.caches.entries()].flatMap(([n, c]) => [...c.entrees.keys()].map((u) => `${n} ${u}`)).sort() }
}

const PIECE_A = "PIECE-SYNTHETIQUE-DE-A"
const PDF_A = "%PDF-SYNTHETIQUE-DE-A"
const PRECACHE = "workbox-precache-v2-http://localhost:3214/"
/** Caches où R18c a observé des entrées D écrites sous A. */
const CACHES_D_OBSERVES = ["pages", "pages-rsc-prefetch", "apis"]

/** État « même profil » observé en R18c, avec contenus synthétiques : entrées écrites sous A par un SW antérieur. */
function profilApresA() {
  const s = new StockageSimule()
  const ajouter = (nom: string, url: string, corps = "x") => { const c = s.caches.get(nom) ?? new CacheSimule(); c.put(url, corps); s.caches.set(nom, c) }
  ajouter("pages", `${ORIGINE}/reserves/fichiers/f-synthetique`, PIECE_A)
  ajouter("pages", `${ORIGINE}/reserves/pv/pv-synthetique/pdf`, PDF_A)
  ajouter("pages", `${ORIGINE}/reserves`)
  ajouter("pages", `${ORIGINE}/reserves/d1-w-a2`)
  ajouter("pages", `${ORIGINE}/tableaux-de-bord`)
  ajouter("pages-rsc-prefetch", `${ORIGINE}/reserves/d1-w-a7?_rsc=1`)
  ajouter("apis", `${ORIGINE}/api/recherche?q=Synthetique`)
  ajouter(PRECACHE, `${ORIGINE}/_next/static/chunks/app/(dashboard)/reserves/fichiers/%5Bid%5D/route-86749e36976d220b.js`)
  ajouter(PRECACHE, `${ORIGINE}/reserves/hors-precache-attendu`)
  return s
}

describe("SW lot D : anciens caches privés (politique de main), même profil, contenus synthétiques", () => {
  it("les caches où des entrées D ont été observées (R18c) sont dans LEGACY_PRIVATE_CACHES", () => {
    for (const nom of CACHES_D_OBSERVES) assert.ok((LEGACY_PRIVATE_CACHES as readonly string[]).includes(nom), nom)
  })
  it("purge de main : aucune entrée D de même origine ni pièce ou PDF de A ne subsiste hors précache ; précache intact", async () => {
    const s = profilApresA()
    await purgeLegacyPrivateCaches(s)
    for (const nom of CACHES_D_OBSERVES) assert.equal(s.caches.has(nom), false, nom)
    for (const c of s.caches.values()) for (const e of c.entrees.values()) { assert.notEqual(e.corps, PIECE_A); assert.notEqual(e.corps, PDF_A) }
    const restantD = s.inventaire().filter((l) => !l.startsWith(`${PRECACHE} `) && /\/(?:reserves|tableaux-de-bord|api\/recherche)(?:[/?]|$)/.test(l))
    assert.deepEqual(restantD, [])
    assert.equal(s.caches.get(PRECACHE)?.entrees.size, 2, "précache non parcouru")
  })
})

describe("SW lot D : garde d'authentification des fichiers du SW inchangée (anciens workers en circulation)", () => {
  it("matcher de main : fichiers PWA publics, aucune exclusion ajoutée pour l'ancien purgeur, routes D authentifiées", () => {
    const re = new RegExp(`^${middlewareConfig.matcher[0]}$`)
    for (const p of ["/sw.js", "/swe-worker-5c72df51bb1f6ee0.js", "/worker-ae16a1cc32a346cc.js", "/workbox-f1770938.js", "/manifest.json"]) assert.equal(re.test(p), false, p)
    for (const p of ["/sw-purge-lot-d.js", "/reserves", "/reserves/d1-w-a2", "/tableaux-de-bord", "/dashboard"]) assert.equal(re.test(p), true, p)
  })
})
