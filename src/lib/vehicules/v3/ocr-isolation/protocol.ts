/**
 * Véhicules V3 — messages échangés avec le processus de lecture isolé (IPC, sérialisation « advanced »).
 * Le parent ne fait confiance à rien de ce que renvoie l'enfant : la réponse est validée champ par champ.
 */
import type { Reading, ReadingReason, ReadingStatus } from "@/lib/hr-documents/recognition/ocr"
import type { DocumentKind } from "@/lib/hr-documents/domain"

export interface ReadRequest {
  type: "read"
  bytes: Uint8Array
  kind: DocumentKind
  timeoutMs: number
  maxPdfImagePixels: number
}

export interface ReadReply { type: "reading"; reading: Reading }

const STATUSES: readonly ReadingStatus[] = ["TEXT_LAYER", "OCR", "ENGINE_MISSING", "TECHNICAL_FAILURE", "UNREADABLE"]
const REASONS: readonly ReadingReason[] = ["TIMEOUT", "IMAGE_NOT_DECODABLE", "PAGE_RENDER_UNAVAILABLE", "PDF_UNREADABLE", "OCR_ERROR", "PDF_IMAGE_TOO_LARGE"]
/** Types acceptés par la route véhicule (HEIC n'y est pas admis). */
const KINDS: readonly DocumentKind[] = ["pdf", "jpeg", "png"]
/** Texte renvoyé borné (la couche texte est déjà limitée à 20 000 caractères ; l'OCR à 3 pages). */
const MAX_TEXT = 200_000

const finite = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
const nullable = (v: unknown, ok: (v: unknown) => boolean) => v === null || ok(v)

export function isReadRequest(m: unknown): m is ReadRequest {
  const r = m as ReadRequest
  return !!r && r.type === "read" && r.bytes instanceof Uint8Array && KINDS.includes(r.kind)
    && finite(r.timeoutMs, 1, 600_000) && finite(r.maxPdfImagePixels, 1, 1e9)
}

/** Réponse de l'enfant, ou `null` si elle ne ressemble pas exactement à une lecture. */
export function parseReadReply(m: unknown): Reading | null {
  const reply = m as ReadReply
  if (!reply || reply.type !== "reading" || !reply.reading || typeof reply.reading !== "object") return null
  const r = reply.reading
  const ok = typeof r.text === "string" && r.text.length <= MAX_TEXT && STATUSES.includes(r.status)
    && nullable(r.reason, (v) => REASONS.includes(v as ReadingReason)) && finite(r.durationMs, 0, 3_600_000) && finite(r.pages, 0, 10_000)
    && nullable(r.rotation, (v) => finite(v, 0, 360)) && nullable(r.confidence, (v) => finite(v, 0, 100)) && typeof r.mrzFound === "boolean"
  return ok ? { text: r.text, status: r.status, reason: r.reason, durationMs: r.durationMs, pages: r.pages, rotation: r.rotation, confidence: r.confidence, mrzFound: r.mrzFound } : null
}
