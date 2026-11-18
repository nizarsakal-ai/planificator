"use client"

import { useEffect } from "react"

/**
 * Caches des anciennes versions du service worker qui contenaient des pages, flux RSC ou réponses d'API privés
 * (dont des réponses redirigées, refusées par WebKit : « ERR_FAILED » sur iPhone). Ils ne sont plus alimentés ;
 * on les supprime pour qu'aucun appareil ne garde ni ne resserve ces réponses.
 */
export const LEGACY_PRIVATE_CACHES = ["pages", "pages-rsc", "pages-rsc-prefetch", "start-url", "apis", "cross-origin",
  "next-data", "static-data-assets"] as const

export async function purgeLegacyPrivateCaches(storage: Pick<CacheStorage, "delete"> | undefined = globalThis.caches) {
  if (!storage) return
  await Promise.all(LEGACY_PRIVATE_CACHES.map(name => storage.delete(name).catch(() => false)))
}

/**
 * Force la PWA à se mettre à jour sans intervention de l'utilisateur.
 *
 * - Vérifie régulièrement (au montage, toutes les 60 s et à chaque retour
 *   sur l'onglet) s'il existe une nouvelle version du service worker.
 * - Quand le nouveau service worker prend le contrôle de la page
 *   (skipWaiting + clientsClaim côté SW), recharge automatiquement la page
 *   pour servir la dernière version — uniquement s'il s'agit d'une vraie
 *   mise à jour, pas de la première installation.
 */
export function ServiceWorkerUpdater() {
  useEffect(() => {
    if (typeof window === "undefined") return
    void purgeLegacyPrivateCaches().catch(() => {})
    if (!("serviceWorker" in navigator)) return

    let refreshing = false
    const hadController = Boolean(navigator.serviceWorker.controller)

    const onControllerChange = () => {
      if (refreshing) return
      // Pas de rechargement à la toute première installation (aucun SW
      // ne contrôlait la page auparavant) : seulement pour une mise à jour.
      if (!hadController) return
      refreshing = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)

    const checkForUpdates = () => {
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.update())
        .catch(() => {})
    }

    // Vérification immédiate + périodique + au retour sur l'onglet
    checkForUpdates()
    const interval = window.setInterval(checkForUpdates, 60_000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") checkForUpdates()
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  return null
}
