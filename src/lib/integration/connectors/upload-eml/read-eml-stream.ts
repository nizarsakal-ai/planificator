import { MAX_EML_BYTES, parseEml } from "./parse-eml"

/** Lit le flux brut avant le parsing MIME, avec un plafond indépendant des en-têtes HTTP. */
export async function readEmlStream(stream: ReadableStream<Uint8Array>) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_EML_BYTES) {
        void reader.cancel().catch(() => undefined)
        return { ok: false, code: "EML_TOO_LARGE" } as const
      }
      if (value.byteLength > 0) chunks.push(value)
    }
  } catch {
    return { ok: false, code: "EML_INVALID" } as const
  } finally {
    reader?.releaseLock()
  }
  return parseEml(Buffer.concat(chunks, length))
}
