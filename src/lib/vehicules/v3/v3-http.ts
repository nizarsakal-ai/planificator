import { assertMutationOrigin } from "../request-origin"
/**
 * Véhicules V3 — aides HTTP communes aux routes privées.
 * Réponses `private, no-store`, codes d'erreur contrôlés (jamais de message SQL),
 * contrôle d'origine des requêtes mutantes et lecture de la clé d'idempotence.
 */
import { MileageDomainError } from "../mileage-domain"
import { isVehiclesV3Enabled } from "./v3-feature-flag"

export const V3_HEADERS: Record<string, string> = { "Cache-Control": "private, no-store", Vary: "Cookie" }

export function v3Json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...V3_HEADERS, ...init.headers } })
}

export function v3Failure(error: unknown): Response {
  if (error instanceof MileageDomainError)
    return v3Json({ code: error.code, error: "Opération refusée" }, { status: error.status })
  return v3Json({ code: "SERVER_ERROR", error: "Erreur serveur" }, { status: 500 })
}

/** 404 explicite tant que le prototype n'est pas activé : aucune route V3 n'est servie. */
export function assertVehiclesV3Enabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isVehiclesV3Enabled(env)) throw new MileageDomainError("FEATURE_DISABLED", 404)
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** Same strict Origin admission as imports and tours, including explicit mobile origins. */
export function assertTrustedOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return
  assertMutationOrigin(request, "INVALID_ORIGIN", env)
}

export function idempotencyKeyOf(request: Request): string | null {
  return request.headers.get("Idempotency-Key")
}

/** Corps réellement borné avant concaténation/parsing ; Content-Length n'est jamais une preuve de taille. */
export async function readV3BodyBytes(request: Request, maxBytes: number, sizeCode = "PAYLOAD_TOO_LARGE"): Promise<Uint8Array> {
  const length = request.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new MileageDomainError("INVALID_CONTENT_LENGTH", 400)
  if (length !== null && Number(length) > maxBytes) throw new MileageDomainError(sizeCode, 413)
  if (!request.body) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new MileageDomainError(sizeCode, 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

export async function v3JsonBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readV3BodyBytes(request, 32 * 1024)
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new MileageDomainError("INVALID_JSON", 400) }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  return body as Record<string, unknown>
}

/** Enveloppe standard d'une route V3 : drapeau, origine, puis traitement ; erreurs normalisées. */
export async function v3Route(request: Request, handler: () => Promise<Response>): Promise<Response> {
  try {
    assertVehiclesV3Enabled()
    assertTrustedOrigin(request)
    return await handler()
  } catch (error) {
    return v3Failure(error)
  }
}
