import type { NextConfig } from "next"
import withPWAInit from "@ducanh2912/next-pwa"

const withPWA = withPWAInit({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    // Données de parc authentifiées : jamais de repli sur la réponse d'une autre session.
    // Cette règle précède les caches génériques API / pages de next-pwa.
    // V3 : les routes documentaires hors préfixe /api/trucks restent elles aussi NetworkOnly
    // (aucun cache partagé ni hors ligne pour des pièces privées).
    runtimeCaching: [{
      urlPattern: ({ url, sameOrigin }) => sameOrigin && (
        url.pathname === "/vehicules" || url.pathname.startsWith("/vehicules/")
        || url.pathname === "/api/trucks" || url.pathname.startsWith("/api/trucks/")
        || url.pathname === "/api/vehicle-documents" || url.pathname.startsWith("/api/vehicle-documents/")
        // Lot C : pièces de facturation et comptabilité (PDF, exports CSV/FEC, pages privées) — jamais de cache SW.
        || url.pathname.startsWith("/api/pdf/devis/") || url.pathname.startsWith("/api/pdf/facture/")
        || url.pathname === "/devis" || url.pathname.startsWith("/devis/")
        || url.pathname === "/factures" || url.pathname.startsWith("/factures/")
        || url.pathname === "/comptabilite" || url.pathname.startsWith("/comptabilite/")
      ),
      handler: "NetworkOnly",
      method: "GET",
    }],
    disableDevLogs: true,
    // Le nouveau service worker s'active dès qu'il est installé…
    skipWaiting: true,
    // …et prend immédiatement le contrôle des onglets déjà ouverts.
    // Combiné à ServiceWorkerUpdater, chaque déploiement est servi sans
    // que l'utilisateur ait à vider le cache.
    clientsClaim: true,
  },
})

const nextConfig: NextConfig = {
  serverExternalPackages: ["@react-pdf/renderer", "unpdf", "exceljs"],
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  images: {
    remotePatterns: [],
  },
}

export default withPWA(nextConfig)
