/**
 * Lecture bornée d'un corps de requête — helper partagé (extrait de `src/lib/vehicules/v3/v3-http.ts`
 * `readV3BodyBytes`, comportement inchangé ; Véhicules conserve son API via délégation avec `MileageDomainError`).
 *
 * Le flux réel est compté et coupé à `maxBytes` ; `Content-Length` n'est qu'un contrôle préalable, jamais une preuve.
 */
import { HttpGuardError, rejectWithHttpGuardError, type RejectFn } from "./guard-error"

export interface BoundedBodyOptions {
  /** Code renvoyé (413) quand le corps dépasse `maxBytes`. */
  sizeCode?: string
  /** Erreur de refus ; par défaut `HttpGuardError`. */
  reject?: RejectFn
}

export async function readBoundedBodyBytes(request: Request, maxBytes: number, options: BoundedBodyOptions = {}): Promise<Uint8Array> {
  const sizeCode = options.sizeCode ?? "PAYLOAD_TOO_LARGE"
  const reject = options.reject ?? rejectWithHttpGuardError
  // Fail-closed : si un `reject` fourni ne lève pas, on lève quand même (jamais de lecture d'un corps refusé).
  const refuse = (code: string, status: number): never => { reject(code, status); throw new HttpGuardError(code, status) }
  const length = request.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) refuse("INVALID_CONTENT_LENGTH", 400)
  if (length !== null && Number(length) > maxBytes) refuse(sizeCode, 413)
  if (!request.body) refuse("INVALID_PAYLOAD", 400)
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); refuse(sizeCode, 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
