import type { NextConfig } from "next"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import withPWAInit from "@ducanh2912/next-pwa"

/**
 * VEHICLE-DOC-OCR-001 R4 — processus de lecture isolé des pièces véhicule : lancé par fork, il échappe au traçage
 * automatique. `scripts/build-vehicle-ocr-worker.mjs` (exécuté par npm run build/dev avant Next) écrit le fichier et
 * le manifeste de sa fermeture ; on les embarque avec la route de lecture. Manifeste absent : rien n'est ajouté et la
 * route répond 503 (lecture indisponible). Manifeste présent mais invalide ou incomplet (fichier listé absent) : la
 * configuration échoue (pas d'embarquement partiel silencieux). Chaque entrée désigne exactement un fichier existant
 * sous node_modules.
 */
export function vehicleOcrWorkerTraceIncludes(root: string = process.cwd()): string[] {
  const manifestPath = path.join(root, ".vehicle-ocr-worker/trace.json")
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { schema?: unknown; worker?: unknown; files?: unknown }
  const safe = (f: unknown): f is string => typeof f === "string" && f.startsWith("node_modules/") && !/[*?[\]{}()!\\\0]/.test(f)
    && path.posix.normalize(f) === f && !f.split("/").includes("..")
  if (manifest.schema !== 1 || manifest.worker !== ".vehicle-ocr-worker/worker.cjs" || !Array.isArray(manifest.files)
    || !manifest.files.length || !manifest.files.every(safe) || !existsSync(path.join(root, ".vehicle-ocr-worker/worker.cjs")))
    throw new Error("Manifeste du processus de lecture OCR invalide : relancer npm run build:vehicle-ocr-worker.")
  const missing = (manifest.files as string[]).filter((f) => !existsSync(path.join(root, f)))
  if (missing.length) throw new Error(`Manifeste du processus de lecture OCR incomplet (${missing.length} fichier(s) absent(s)) : relancer npm run build:vehicle-ocr-worker.`)
  return ["./.vehicle-ocr-worker/worker.cjs", ...manifest.files.map((f: string) => `./${f}`)]
}

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
        url.pathname === "/mes-documents" || url.pathname === "/rh/documents"
        || url.pathname === "/api/hr-documents" || url.pathname.startsWith("/api/hr-documents/")
        || url.pathname === "/vehicules" || url.pathname.startsWith("/vehicules/")
        || url.pathname === "/api/trucks" || url.pathname.startsWith("/api/trucks/")
        || url.pathname === "/api/vehicle-documents" || url.pathname.startsWith("/api/vehicle-documents/")
        // Lot C : pièces de facturation et comptabilité (PDF, exports CSV/FEC, pages privées) — jamais de cache SW.
        || url.pathname.startsWith("/api/pdf/devis/") || url.pathname.startsWith("/api/pdf/facture/")
        || url.pathname === "/devis" || url.pathname.startsWith("/devis/")
        || url.pathname === "/factures" || url.pathname.startsWith("/factures/")
        || url.pathname === "/factures-fournisseurs" || url.pathname.startsWith("/factures-fournisseurs/")
        || url.pathname === "/comptabilite" || url.pathname.startsWith("/comptabilite/")
        // Photos d'engins (SPEC-WORKSITE-PHOTOS-001) : page et API privées, fichiers par proxy — jamais de cache SW.
        || url.pathname === "/photos-engins" || url.pathname.startsWith("/photos-engins/")
        || url.pathname === "/api/worksite-photos" || url.pathname.startsWith("/api/worksite-photos/")
        || url.pathname.startsWith("/api/auth/drive")
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

const OCR_TRACE_INCLUDES = ["./node_modules/@tesseract.js-data/fra/4.0.0_best_int/**", "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/**",
  "./node_modules/tesseract.js-core/tesseract-core*.wasm"]
const OCR_TRACE_EXCLUDES = ["./node_modules/@tesseract.js-data/*/4.0.0/**"]

const nextConfig: NextConfig = {
  serverExternalPackages: ["@react-pdf/renderer", "unpdf", "exceljs", "tesseract.js", "@tesseract.js-data/fra", "@tesseract.js-data/eng"],
  // PLV2-DOC-RH-002 : moteur WASM et modèles OCR lus par chemin au moment de l'appel, invisibles du traçage automatique.
  // Toutes les variantes du cœur : sous Node, tesseract.js 7 choisit la variante selon le processeur (SIMD) et ne retient
  // pas la variante LSTM (il compare un booléen aux codes OEM) ; les modèles « 4.0.0 » non utilisés sont exclus.
  // Même moteur pour la lecture des pièces véhicule (clé en motif : « [id] » serait lu comme une classe de caractères).
  outputFileTracingIncludes: {
    "/api/hr-documents/recognize": OCR_TRACE_INCLUDES,
    "/api/trucks/*/documents/recognize": [...OCR_TRACE_INCLUDES, ...vehicleOcrWorkerTraceIncludes()],
  },
  outputFileTracingExcludes: {
    "/api/hr-documents/recognize": OCR_TRACE_EXCLUDES,
    "/api/trucks/*/documents/recognize": OCR_TRACE_EXCLUDES,
  },
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
