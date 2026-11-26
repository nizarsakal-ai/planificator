import { createHash } from "node:crypto"

type PrivateIdentity = {
  companyId: string
  acquisitionMessageId: string
  attachmentId: string
  publicId: string
}

type VerificationInput = {
  /** Identité résolue côté serveur. Le calcul de l’identifiant raw est hors de ce module. */
  expected: PrivateIdentity & { sha256: string; sizeBytes: number }
  /** Identité du candidat à vérifier, résolue sans faire confiance au MIME. */
  candidate: PrivateIdentity & { resourceType: string; deliveryType: string }
  /** URL issue du signataire de confiance pour cet identifiant exact. */
  signedUrl: string
  allowedOrigin: string
}

type ReadPrivateResponse = (
  url: string,
  options: { signal: AbortSignal; redirect: "error"; cache: "no-store" },
) => Promise<Response>

const MAX_BYTES = 10 * 1024 * 1024
const MAX_DURATION_MS = 8_000

/** Preuve des octets seulement. Aucun raccordement fournisseur dans ce module. */
export async function verifyPrivateAttachment(
  input: VerificationInput,
  read: ReadPrivateResponse,
  durationMs = MAX_DURATION_MS,
): Promise<boolean> {
  const expected = { ...input.expected }
  const candidate = { ...input.candidate }
  if (
    !expected.companyId || !expected.acquisitionMessageId || !expected.attachmentId || !expected.publicId ||
    expected.companyId !== candidate.companyId ||
    expected.acquisitionMessageId !== candidate.acquisitionMessageId ||
    expected.attachmentId !== candidate.attachmentId ||
    expected.publicId !== candidate.publicId ||
    candidate.resourceType !== "raw" || candidate.deliveryType !== "authenticated" ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 || expected.sizeBytes > MAX_BYTES ||
    !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_DURATION_MS
  ) return false

  let url: URL
  try {
    url = new URL(input.signedUrl)
  } catch {
    return false
  }
  if (
    url.protocol !== "https:" || url.origin !== input.allowedOrigin ||
    url.username || url.password || url.hash
  ) return false

  const controller = new AbortController()
  const expiresAt = performance.now() + durationMs
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let done = false
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("Délai de vérification dépassé"))
    }, durationMs)
  })
  const expired = () => controller.signal.aborted || performance.now() >= expiresAt
  const verify = async () => {
    const target = url.href
    response = await read(target, { signal: controller.signal, redirect: "error", cache: "no-store" })
    if (expired()) {
      void response.body?.cancel().catch(() => undefined)
      return false
    }
    if (response.status !== 200 || response.redirected || response.url !== target || !response.body) {
      return false
    }
    const encoding = response.headers.get("content-encoding")
    if (encoding !== null && encoding.toLowerCase() !== "identity") return false
    const length = response.headers.get("content-length")
    if (length !== null && length !== String(expected.sizeBytes)) return false

    reader = response.body.getReader()
    const hash = createHash("sha256")
    let size = 0
    while (!expired()) {
      const part = await reader.read()
      if (expired()) return false
      if (part.done) {
        done = true
        return size === expected.sizeBytes && hash.digest("hex") === expected.sha256
      }
      if (part.value.byteLength === 0) return false
      size += part.value.byteLength
      if (size > MAX_BYTES || size > expected.sizeBytes) return false
      hash.update(part.value)
    }
    return false
  }

  try {
    return await Promise.race([verify(), deadline])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    if (!done) {
      controller.abort()
      if (reader) void reader.cancel().catch(() => undefined)
      else if (response?.body) void response.body.cancel().catch(() => undefined)
    }
    reader?.releaseLock()
  }
}
