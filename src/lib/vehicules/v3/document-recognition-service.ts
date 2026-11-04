/**
 * Véhicules V3 — lecture d'une pièce avant son ajout : proposition de champs, sans aucune écriture.
 * Droits relus côté serveur (administrateur de l'entreprise de la session, camion actif, rubrique visible), fichier
 * contrôlé comme au dépôt, lecture locale (couche texte du PDF puis OCR Tesseract embarqué, module RH partagé),
 * une lecture à la fois par instance, délai borné. Rien n'est stocké ; ni le texte lu ni les valeurs ne sont
 * journalisés ni renvoyés hors des champs proposés.
 */
import { z } from "zod"
import { readDocument, type Reading } from "@/lib/hr-documents/recognition/ocr"
import type { DocumentKind } from "@/lib/hr-documents/domain"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession } from "../mileage-access"
import { authorizeVehicleV3 } from "./v3-access"
import { getVehicleDocumentMaxBytes, validateDocumentFile, VEHICLE_DOCUMENT_CATEGORIES } from "./document-domain"
import { extractVehicleDocumentFields, isVehicleDocumentRecognitionEnabled, type RecognitionProposal } from "./document-recognition-domain"
import type { DocumentFileInput, DocumentServiceDeps } from "./document-service"

export type DocumentReader = (bytes: Uint8Array, kind: DocumentKind, opts: { timeoutMs: number }) => Promise<Reading>

export interface DocumentRecognitionDeps extends DocumentServiceDeps {
  /** Lecteur injectable (tests) ; par défaut la lecture locale partagée avec les documents RH. */
  read?: DocumentReader
}

/** Délai de lecture ; la réponse est rendue au plus tard à `RESPONSE_DEADLINE_MS` même si le moteur tarde. */
export const RECOGNITION_TIMEOUT_MS = 25_000
const RESPONSE_DEADLINE_MS = 30_000
/** Une lecture OCR à la fois par instance : ≈ 100 Mo et un cœur pendant quelques secondes. */
const MAX_CONCURRENT = 1
let running = 0

/** Tests seulement : nombre de lectures en cours sur cette instance. */
export function runningRecognitions() { return running }

const OCR_CONFIDENCE_FLOOR = 70
const KIND: Record<string, DocumentKind> = { "application/pdf": "pdf", "image/jpeg": "jpeg", "image/png": "png" }
const commandSchema = z.object({ category: z.enum(VEHICLE_DOCUMENT_CATEGORIES) }).strict()
const transactionOptions = { maxWait: 5_000, timeout: 10_000 }

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

  if (running >= MAX_CONCURRENT) throw new MileageDomainError("RECOGNITION_BUSY", 429)
  running++
  const reader = deps.read ?? readDocument
  // Le compteur suit la fin réelle de la lecture, pas la réponse : un moteur en retard continue d'occuper sa place.
  const reading = Promise.resolve().then(() => reader(file.bytes, KIND[checked.mimeType], { timeoutMs: RECOGNITION_TIMEOUT_MS })).finally(() => { running-- })
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: Reading
  try {
    result = await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MileageDomainError("RECOGNITION_TIMEOUT", 504)), RESPONSE_DEADLINE_MS) })])
  } catch (error) {
    if (error instanceof MileageDomainError) throw error
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
