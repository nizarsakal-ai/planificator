import { MileageDomainError } from "./mileage-domain"

/** Bound the actual streamed bytes; Content-Length is only an additional integrity check. */
export async function readImportBoundedBody(
  input: {headers:Headers;body:ReadableStream<Uint8Array>|null},
  options: { maxBytes: number; timeoutMs?: number; limitCode?: string; invalidStatus?: number; decodedContent?: boolean } ,
): Promise<Buffer> {
  const limitCode = options.limitCode ?? "PAYLOAD_LIMIT"
  const invalidStatus = options.invalidStatus ?? 400
  const rejectBody = (code: string, status: number): never => {
    void input.body?.cancel().catch(() => undefined)
    throw new MileageDomainError(code, status)
  }
  // Fetch decodes compressed responses but retains their encoded Content-Length.
  // Request bodies remain strict unless the caller explicitly identifies a decoded response.
  const encoding = input.headers.get("content-encoding")?.trim().toLowerCase()
  const declared = options.decodedContent && encoding && encoding !== "identity" ? null : input.headers.get("content-length")
  let expected: number | null = null
  if (declared !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declared)) rejectBody("CONTENT_LENGTH_INVALID", invalidStatus)
    expected = Number(declared)
    if (!Number.isSafeInteger(expected)) rejectBody("CONTENT_LENGTH_INVALID", invalidStatus)
    if (expected > options.maxBytes) rejectBody(limitCode, invalidStatus === 400 ? 413 : invalidStatus)
  }
  if (!input.body) {
    if (expected !== null && expected !== 0) rejectBody("CONTENT_LENGTH_MISMATCH", invalidStatus)
    return Buffer.alloc(0)
  }
  const reader = input.body.getReader()
  const chunks: Buffer[] = []
  let size = 0, done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MileageDomainError("BODY_TIMEOUT", invalidStatus === 400 ? 408 : 504)), options.timeoutMs ?? 10_000)
  })
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), expired])
      if (part.done) { done = true; break }
      size += part.value.byteLength
      if (size > options.maxBytes) throw new MileageDomainError(limitCode, invalidStatus === 400 ? 413 : invalidStatus)
      if (expected !== null && size > expected) throw new MileageDomainError("CONTENT_LENGTH_MISMATCH", invalidStatus)
      chunks.push(Buffer.from(part.value))
    }
    if (expected !== null && size !== expected) throw new MileageDomainError("CONTENT_LENGTH_MISMATCH", invalidStatus)
    return Buffer.concat(chunks, size)
  } finally {
    if (timer) clearTimeout(timer)
    if (!done) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
