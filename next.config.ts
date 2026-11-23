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

/**
 * Pages HTML, flux RSC et API : jamais interceptés par le service worker.
 * Ils sont privés (session, rôle, entreprise) et passent par des redirections d'authentification. Servis depuis un cache,
 * ils exposaient la page d'un autre compte sur un appareil partagé, et WebKit (Safari, Chrome iOS) refuse une réponse
 * redirigée rendue par un service worker : la navigation échouait avec « ERR_FAILED » (incident du 18/11).
 * Seuls les fichiers statiques versionnés restent en cache ; aucune règle « attrape-tout » : sans règle, le navigateur
 * charge la page lui-même.
 */
export const PWA_STATIC_RUNTIME_CACHING = [
  { urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i, handler: "CacheFirst" as const,
    options: { cacheName: "google-fonts-webfonts", expiration: { maxEntries: 4, maxAgeSeconds: 31536e3 } } },
  { urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i, handler: "StaleWhileRevalidate" as const,
    options: { cacheName: "google-fonts-stylesheets", expiration: { maxEntries: 4, maxAgeSeconds: 604800 } } },
  { urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) => sameOrigin && /^\/_next\/static\/.+\.(?:js|css|woff2?)$/i.test(url.pathname),
    handler: "CacheFirst" as const, options: { cacheName: "next-static-assets", expiration: { maxEntries: 200, maxAgeSeconds: 2592e3 } } },
  { urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) => sameOrigin && /^\/(?:icons\/.+|favicon-32x32\.png|apple-touch-icon\.png)$/i.test(url.pathname),
    handler: "StaleWhileRevalidate" as const, options: { cacheName: "app-icons", expiration: { maxEntries: 32, maxAgeSeconds: 2592e3 } } },
]

const withPWA = withPWAInit({
  dest: "public",
  // Aucune mise en cache des pages : ni à la navigation, ni de l'URL de démarrage (voir PWA_STATIC_RUNTIME_CACHING).
  cacheOnFrontEndNav: false,
  aggressiveFrontEndNavCaching: false,
  cacheStartUrl: false,
  dynamicStartUrl: false,
  // src/worker/index.ts : purge des anciens caches privés à l'activation du service worker.
  customWorkerSrc: "src/worker",
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
  extendDefaultRuntimeCaching: false,
  workboxOptions: {
    // Fichiers statiques seulement : pages privées (RH, parc, facturation, photos…) et API ne sont jamais
    // interceptées, donc jamais mises en cache ni servies à une autre session.
    runtimeCaching: PWA_STATIC_RUNTIME_CACHING,
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
    // Réduit le pic mémoire de webpack au build : le conteneur Vercel a déjà été tué par manque de mémoire
    // (OOM, SIGKILL) sur main (#176, #181-#183) et sur la PR #198. Compilation un peu plus lente, sortie identique.
    webpackMemoryOptimizations: true,
    // 23/11/2026 : nouveaux arrêts par manque de mémoire (PR #215). Chaque tâche de génération des pages charge toute
    // l'application en mémoire : au plus 2 tâches en parallèle, et leur nombre est réduit si la mémoire libre manque.
    // Compilation un peu plus lente, sortie identique.
    cpus: 2,
    memoryBasedWorkersCount: true,
  },
  images: {
    remotePatterns: [],
  },
}

export default withPWA(nextConfig)
