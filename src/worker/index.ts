/// <reference lib="webworker" />
/**
 * Code ajouté au service worker généré par next-pwa (importé par sw.js).
 * À l'activation d'une nouvelle version : suppression des caches qui contenaient des pages, flux RSC ou réponses
 * d'API privés. Ils ne sont plus alimentés (voir PWA_STATIC_RUNTIME_CACHING dans next.config.ts) ; les supprimer ici
 * couvre aussi les appareils où la page elle-même ne s'ouvrait plus (« ERR_FAILED » sur iPhone, 18/11).
 * Liste tenue identique à LEGACY_PRIVATE_CACHES (src/components/ServiceWorkerUpdater.tsx), vérifiée par test.
 */
declare const self: ServiceWorkerGlobalScope

const LEGACY_PRIVATE_CACHES = ["pages", "pages-rsc", "pages-rsc-prefetch", "start-url", "apis", "cross-origin",
  "next-data", "static-data-assets"]

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all(LEGACY_PRIVATE_CACHES.map((name) => caches.delete(name).catch(() => false))))
})

export {}
