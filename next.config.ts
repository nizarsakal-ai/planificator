import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  serverExternalPackages: ["@react-pdf/renderer"],
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb",
    },
  },
  images: {
    remotePatterns: [
      // Ajouter les domaines d'images uploadées ici (UploadThing, S3, etc.)
    ],
  },
}

export default nextConfig
