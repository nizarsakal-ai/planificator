import type { NextConfig } from "next"
import withPWAInit from "@ducanh2912/next-pwa"

const withPWA = withPWAInit({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
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
  serverExternalPackages: ["@react-pdf/renderer"],
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
