/**
 * Véhicules V3 — lecture d'une pièce avant son ajout : proposition de champs, sans aucune écriture.
 * Droits relus côté serveur (administrateur de l'entreprise de la session, camion actif, rubrique visible), fichier
 * contrôlé comme au dépôt, lecture locale (couche texte du PDF puis OCR Tesseract embarqué, code de lecture RH partagé
 * mais moteur distinct), une lecture à la fois par instance. Rien n'est stocké ; ni le texte lu ni les valeurs ne sont
 * journalisés ni renvoyés hors des champs proposés.
 *
 * R3 — par défaut, TOUT le traitement à risque (couche texte PDF, analyse et extraction des images, décodage,
 * chargement et calcul OCR) s'exécute dans un processus enfant neuf (`ocr-isolation/`), tué (SIGKILL) à l'échéance :
 * le calcul s'arrête réellement, y compris en natif ou WASM, et sa place est rendue dès la fin effective du processus
 * (quelques millisecondes), donc pas de 429 durable. Tas de l'enfant borné, mémoire résidente surveillée, environnement
 * sans secret. Empaquetage du processus absent : 503 RECOGNITION_UNAVAILABLE explicite (jamais de repli silencieux
 * sur une lecture dans le serveur ni de suppression muette de la lecture PDF).
 *
 * Comptage (inchangé depuis R2.1) : à l'échéance, la lecture est abandonnée (signal) ; la réponse 504 part au plus tard
 * après un court délai de grâce. Tant que la lecture (ici : le processus) OU l'arrêt d'un moteur injecté ne sont pas
 * réellement finis, le travail reste compté « abandonné » et occupe une des MAX_UNFINISHED places (au-delà : 429).
 * Le mode « dans le serveur » (moteur `engine`, R2.1) ne subsiste que par injection (tests). Aucune preuve Vercel.
 */
import { existsSync } from "node:fs"
import { z } from "zod"
import { readDocument, type Reading } from "@/lib/hr-documents/recognition/ocr"
import type { DocumentKind } from "@/lib/hr-documents/domain"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession } from "../mileage-access"
import { authorizeVehicleV3 } from "./v3-access"
import { getVehicleDocumentMaxBytes, validateDocumentFile, VEHICLE_DOCUMENT_CATEGORIES } from "./document-domain"
import { extractVehicleDocumentFields, isVehicleDocumentRecognitionEnabled, type RecognitionProposal } from "./document-recognition-domain"
import type { VehicleOcrEngine } from "./document-recognition-engine"
import type { DocumentFileInput, DocumentServiceDeps } from "./document-service"
import { createIsolatedReader, IsolatedReaderUnavailable, resolveWorkerPath } from "./ocr-isolation/isolated-reader"

export type DocumentReader = (bytes: Uint8Array, kind: DocumentKind, opts: { timeoutMs: number; signal: AbortSignal }) => Promise<Reading>

export interface DocumentRecognitionDeps extends DocumentServiceDeps {
  /** Lecteur injectable (tests) ; par défaut la lecture dans un processus enfant isolé. */
  read?: DocumentReader
  /** Moteur dans le serveur arrêté à l'échéance (tests R2.1 seulement) ; absent par défaut. */
  engine?: VehicleOcrEngine
  /** Tests : échéance de réponse et délai de grâce après arrêt. */
  deadlineMs?: number
  graceMs?: number
}

/** Délai de lecture coopératif ; à `RESPONSE_DEADLINE_MS`, lecture abandonnée et moteur arrêté. */
export const RECOGNITION_TIMEOUT_MS = 25_000
const RESPONSE_DEADLINE_MS = 30_000
const GRACE_MS = 3_000
/** Plus grande image d'un PDF acceptée (pixels déclarés, avant décompression) ; total ≤ 3 fois cette valeur. */
export const MAX_PDF_IMAGE_PIXELS = 25_000_000
/** Une lecture OCR à la fois par instance : ≈ 100 Mo et un cœur pendant quelques secondes. */
const MAX_CONCURRENT = 1
/** Lectures actives + abandonnées encore en cours de fin : au-delà, 429 plutôt qu'empiler du calcul non arrêté. */
const MAX_UNFINISHED = 2
let running = 0
let abandoned = 0

/** Tests seulement : lectures en cours et lectures abandonnées non terminées sur cette instance. */
export function runningRecognitions() { return running }
export function abandonedRecognitions() { return abandoned }

const OCR_CONFIDENCE_FLOOR = 70
const KIND: Record<string, DocumentKind> = { "application/pdf": "pdf", "image/jpeg": "jpeg", "image/png": "png" }
const commandSchema = z.object({ category: z.enum(VEHICLE_DOCUMENT_CATEGORIES) }).strict()
const transactionOptions = { maxWait: 5_000, timeout: 10_000 }

/** Lecteur par défaut : processus isolé ; empaquetage absent = refus explicite AVANT d'occuper une place. */
function defaultReader(env: NodeJS.ProcessEnv): DocumentReader {
  const workerPath = resolveWorkerPath(env)
  if (!existsSync(workerPath)) throw new MileageDomainError("RECOGNITION_UNAVAILABLE", 503)
  return createIsolatedReader({ workerPath, maxPdfImagePixels: MAX_PDF_IMAGE_PIXELS })
}

/** Lecture dans le serveur (R2.1), seulement avec un moteur injecté : jamais le chemin par défaut. */
const inServerReader = (engine: VehicleOcrEngine): DocumentReader => (bytes, kind, opts) =>
  readDocument(bytes, kind, { ...opts, engine: engine.get, maxPdfImagePixels: MAX_PDF_IMAGE_PIXELS })

export function assertRecognitionEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (!isVehicleDocumentRecognitionEnabled(env)) throw new MileageDomainError("RECOGNITION_DISABLED", 404)
}

export async function recognizeVehicleDocument(truckId: string, body: unknown, file: DocumentFileInput, deps: DocumentRecognitionDeps): Promise<RecognitionProposal> {
  const env = deps.env ?? process.env
  assertRecognitionEnabled(env)
  const session = requireMileageSession(await deps.auth())
  const parsed = commandSchema.safeParse(body)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const { category } = parsed.data
  const truck = await deps.db.$transaction(async (tx) => {
    const { truck, categories } = await authorizeVehicleV3(tx, truckId, session, "DOCUMENT_WRITE")
    if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
    if (!categories.includes(category)) throw new MileageDomainError("FORBIDDEN", 403)
    return { matricule: truck.matricule, marque: truck.marque }
  }, transactionOptions)
  const checked = validateDocumentFile(file, getVehicleDocumentMaxBytes(env))

  // Moteur injecté sans lecteur (tests R2/R2.1) : lecture dans le serveur avec ce moteur ; sinon processus isolé.
  const reader: DocumentReader = deps.read ?? (deps.engine ? inServerReader(deps.engine) : defaultReader(env))
  if (running >= MAX_CONCURRENT || running + abandoned >= MAX_UNFINISHED) throw new MileageDomainError("RECOGNITION_BUSY", 429)
  running++
  let released = false
  const release = () => { if (!released) { released = true; running-- } }
  const engine = deps.engine ?? null
  const controller = new AbortController()
  let settled = false
  const reading = Promise.resolve().then(() => reader(file.bytes, KIND[checked.mimeType], { timeoutMs: RECOGNITION_TIMEOUT_MS, signal: controller.signal }))
  void reading.then(() => { settled = true; release() }, () => { settled = true; release() })
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: Reading
  try {
    result = await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MileageDomainError("RECOGNITION_TIMEOUT", 504)), deps.deadlineMs ?? RESPONSE_DEADLINE_MS) })])
  } catch (error) {
    if (timer) clearTimeout(timer)
    if (error instanceof MileageDomainError && error.code === "RECOGNITION_TIMEOUT" && !settled) {
      // Compté « non terminé » AVANT l'abandon : même si la lecture rend aussitôt la main sur le signal, l'arrêt du
      // moteur peut rester pendant ; il occupe sa place jusqu'à ce que lecture ET arrêt soient réellement finis.
      abandoned++
      controller.abort()
      const stopping = Promise.resolve().then(() => engine?.kill()).then(() => {}, () => {})
      const finished = Promise.all([reading.then(() => {}, () => {}), stopping])
      void finished.then(() => { abandoned-- })
      // Attente BORNÉE (lecture et arrêt) : la réponse 504 part au plus tard après le délai de grâce.
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([finished, new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, deps.graceMs ?? GRACE_MS) })])
      if (graceTimer) clearTimeout(graceTimer)
      release()
    }
    if (error instanceof MileageDomainError) throw error
    if (error instanceof IsolatedReaderUnavailable) throw new MileageDomainError("RECOGNITION_UNAVAILABLE", 503)
    throw new MileageDomainError("RECOGNITION_FAILED", 502)
  } finally {
    if (timer) clearTimeout(timer)
  }

  const lowConfidence = result.status === "OCR" && (result.confidence ?? 0) < OCR_CONFIDENCE_FLOOR
  const extracted = result.text
    ? extractVehicleDocumentFields({ category, text: result.text, lowConfidence, truck })
    : { category, fields: {}, observations: [], checks: [], otherCategory: null }
  return { ...extracted, reading: { status: result.status, reason: result.reason, pages: result.pages, durationMs: result.durationMs } }
}
