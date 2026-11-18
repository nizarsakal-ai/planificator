import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { PWA_STATIC_RUNTIME_CACHING } from "../../next.config"
import { LEGACY_PRIVATE_CACHES, purgeLegacyPrivateCaches } from "../../src/components/ServiceWorkerUpdater"
import { config as middlewareConfig } from "../../src/middleware"

// Incident 18/11 : « ERR_FAILED » sur iPhone. Le service worker servait des pages privées depuis son cache
// (réponses redirigées refusées par WebKit). Les pages, flux RSC et API ne doivent plus être interceptés.
const ORIGIN = "https://www.galyaevents.fr"
type Rule = (typeof PWA_STATIC_RUNTIME_CACHING)[number]
function matches(rule: Rule, href: string) {
  const url = new URL(href), sameOrigin = url.origin === ORIGIN
  return rule.urlPattern instanceof RegExp ? rule.urlPattern.test(href) : rule.urlPattern({ url, sameOrigin })
}
const handled = (path: string) => PWA_STATIC_RUNTIME_CACHING.some(rule => matches(rule, path.startsWith("http") ? path : ORIGIN + path))

describe("service worker : seuls les fichiers statiques sont mis en cache", () => {
  it("pages, redirections d'authentification, API et flux RSC : jamais interceptés", () => {
    for (const path of ["/", "/login", "/dashboard", "/super-admin/entreprises", "/rh/documents", "/mes-documents",
      "/api/auth/session", "/api/hr-documents", "/planning?_rsc=abc", "/manifest.json", "/fichier.json"])
      assert.equal(handled(path), false, path)
  })
  it("fichiers versionnés de Next, icônes et polices : mis en cache", () => {
    for (const path of ["/_next/static/chunks/app/layout-1.js", "/_next/static/css/a.css", "/_next/static/media/x.woff2",
      "/icons/icon-192x192.png", "/apple-touch-icon.png", "https://fonts.gstatic.com/s/a.woff2"])
      assert.equal(handled(path), true, path)
  })
  it("aucune mise en cache des pages ni de l'URL de démarrage, règles par défaut de next-pwa désactivées", () => {
    const src = readFileSync("next.config.ts", "utf8")
    for (const flag of ["cacheOnFrontEndNav: false", "aggressiveFrontEndNavCaching: false", "cacheStartUrl: false",
      "dynamicStartUrl: false", "extendDefaultRuntimeCaching: false", "runtimeCaching: PWA_STATIC_RUNTIME_CACHING",
      'customWorkerSrc: "src/worker"'])
      assert.ok(src.includes(flag), flag)
  })
})

describe("anciens caches privés : purgés côté page et à l'activation du service worker", () => {
  it("la page supprime chaque ancien cache, même si l'une des suppressions échoue", async () => {
    const deleted: string[] = []
    await purgeLegacyPrivateCaches({ delete: async (name: string) => { deleted.push(name); if (name === "apis") throw new Error("x"); return true } })
    assert.deepEqual(deleted, [...LEGACY_PRIVATE_CACHES])
    await purgeLegacyPrivateCaches(undefined)
  })
  it("le code ajouté au service worker purge la même liste à l'activation", () => {
    const worker = readFileSync("src/worker/index.ts", "utf8")
    const list = worker.match(/const LEGACY_PRIVATE_CACHES = (\[[^\]]+\])/)?.[1]
    assert.ok(list)
    assert.deepEqual(JSON.parse(list.replace(/\s+/g, " ")), [...LEGACY_PRIVATE_CACHES])
    assert.match(worker, /self\.addEventListener\("activate"/)
  })
  it("les fichiers du service worker restent publics : le middleware d'authentification ne les intercepte pas", () => {
    const matcher = new RegExp(`^${middlewareConfig.matcher[0]}$`)
    for (const path of ["/sw.js", "/worker-ae16a1cc32a346cc.js", "/workbox-89dca875.js", "/swe-worker-5c72df51bb1f6ee0.js", "/manifest.json"])
      assert.equal(matcher.test(path), false, path)
    for (const path of ["/login", "/super-admin/entreprises", "/dashboard"]) assert.equal(matcher.test(path), true, path)
  })
})

describe("connexion refusée : motif journalisé sans donnée personnelle", () => {
  it("chaque refus porte un motif fixe ; le navigateur reçoit toujours la même réponse", () => {
    const src = readFileSync("src/auth.ts", "utf8")
    for (const reason of ["INVALID_INPUT", "USER_NOT_FOUND", "USER_INACTIVE", "BAD_PASSWORD", "NO_ACTIVE_COMPANY_ACCESS"])
      assert.match(src, new RegExp(`logLoginRefusal\\("${reason}"\\); return null`), reason)
    assert.match(src, /log\("\[auth\] LOGIN_REFUSED", \{ reason \}\)/)
    assert.doesNotMatch(src, /logLoginRefusal\([^)]*email/)
  })
})
