/**
 * Véhicules V3 — point d'entrée du processus de lecture isolé (une lecture par processus, puis fin).
 *
 * Tout le traitement à risque s'exécute ici et nulle part ailleurs : couche texte du PDF (pdf.js), analyse des images
 * déclarées, extraction et décompression des images, décodage sharp/libvips, chargement et exécution de Tesseract.
 * Le parent tue ce processus (SIGKILL) à l'échéance ou à l'abandon ; le chien de garde le tue aussi de lui-même
 * (mémoire résidente, échéance absolue, parent disparu) même si le fil principal est bloqué en natif.
 *
 * Empaqueté par `scripts/build-vehicle-ocr-worker.mjs` (esbuild, CommonJS) ; dépendances natives/WASM laissées
 * externes et résolues depuis `node_modules`. Aucune sortie standard : ni texte lu ni valeur n'est journalisé.
 */
import sharp from "sharp"
import { createOcrEngineHandle, readDocument, type OcrEngineHandle } from "@/lib/hr-documents/recognition/ocr"
import { isReadRequest } from "./protocol"
import { startWatchdog } from "./watchdog"

const MB = 1024 * 1024
const rssLimitBytes = Number(process.env.VEHICLE_OCR_RSS_LIMIT_MB || 768) * MB
const hardLimitMs = Number(process.env.VEHICLE_OCR_HARD_LIMIT_MS || 40_000)
startWatchdog({ rssLimitBytes, hardLimitMs })

// Un seul fil libvips, aucun cache : empreinte mémoire prévisible pour une seule lecture.
sharp.concurrency(1)
sharp.cache(false)

const die = () => { try { process.kill(process.pid, "SIGKILL") } catch { process.exit(137) } }
process.on("disconnect", die)

process.once("message", async (message: unknown) => {
  if (!isReadRequest(message)) return die()
  let handle: Promise<OcrEngineHandle> | null = null
  const reading = await readDocument(message.bytes, message.kind, {
    timeoutMs: message.timeoutMs,
    maxPdfImagePixels: message.maxPdfImagePixels,
    engine: async () => (await (handle ??= createOcrEngineHandle())).engine,
  })
  // Fin du processus juste après l'envoi : la terminaison des workers Tesseract n'est pas attendue (le processus
  // entier disparaît, workers compris).
  process.send!({ type: "reading", reading }, () => process.exit(0))
})
