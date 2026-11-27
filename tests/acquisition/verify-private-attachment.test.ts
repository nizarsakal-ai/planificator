import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { verifyPrivateAttachment } from "../../src/lib/acquisition/attachments/verify-private-attachment"

const origin = "https://stockage-fictif.example"
const url = `${origin}/objet-prive-fictif`
const body = Buffer.from("Données fictives de recette")
const identity = {
  companyId: "societe-fictive",
  acquisitionMessageId: "message-fictif",
  attachmentId: "piece-fictive",
  publicId: "reserve/objet-fictif",
}
const input = {
  expected: { ...identity, sizeBytes: body.length, sha256: createHash("sha256").update(body).digest("hex") },
  candidate: { ...identity, resourceType: "raw", deliveryType: "authenticated" },
  signedUrl: url,
  allowedOrigin: origin,
}

function reply(data: BodyInit, options: ResponseInit = {}, finalUrl = url) {
  const response = new Response(data, options)
  Object.defineProperty(response, "url", { value: finalUrl })
  return response
}

test("vérifie les octets d’un vrai flux en plusieurs morceaux", async () => {
  const verified = await verifyPrivateAttachment(input, async (target, options) => {
    assert.equal(target, url)
    assert.equal(options.redirect, "error")
    assert.equal(options.cache, "no-store")
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 7))
        controller.enqueue(body.subarray(7))
        controller.close()
      },
    })
    return reply(stream, { headers: { "Content-Length": String(body.length) } })
  })
  assert.equal(verified, true)
})

test("refuse toute variation de société, message, pièce, identifiant ou type avant le transport", async () => {
  for (const change of [
    { companyId: "autre-societe" }, { acquisitionMessageId: "autre-message" },
    { attachmentId: "autre-piece" }, { publicId: "autre-objet" },
    { resourceType: "image" }, { deliveryType: "upload" },
  ]) {
    let calls = 0
    const verified = await verifyPrivateAttachment({ ...input, candidate: { ...input.candidate, ...change } }, async () => {
      calls++
      return reply(body)
    })
    assert.equal(calls, 0)
    assert.equal(verified, false)
  }
})

test("refuse les destinations étrangères ou ambiguës et les réponses redirigées", async () => {
  for (const signedUrl of [
    "https://autre.example/objet",
    "http://stockage-fictif.example/objet",
    "https://utilisateur@stockage-fictif.example/objet",
    `${url}#fragment`,
  ]) {
    let calls = 0
    assert.equal(await verifyPrivateAttachment({ ...input, signedUrl }, async () => {
      calls++
      return reply(body)
    }), false)
    assert.equal(calls, 0)
  }
  assert.equal(await verifyPrivateAttachment(input, async () => reply(body, {}, `${origin}/autre-objet`)), false)
  assert.equal(await verifyPrivateAttachment(input, async () => {
    const response = reply(body)
    Object.defineProperty(response, "redirected", { value: true })
    return response
  }), false)
})

test("refuse un flux plus long que la taille déclarée et annule la lecture", async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body)
      controller.enqueue(Buffer.from("x"))
    },
    cancel() { cancelled = true },
  })
  assert.equal(await verifyPrivateAttachment(input, async () =>
    reply(stream, { headers: { "Content-Length": String(body.length) } })
  ), false)
  assert.equal(cancelled, true)
})

test("refuse un SHA divergent, un flux court et une réponse compressée", async () => {
  assert.equal(await verifyPrivateAttachment(input, async () => reply(Buffer.alloc(body.length))), false)
  assert.equal(await verifyPrivateAttachment(input, async () => reply(body.subarray(1))), false)
  assert.equal(await verifyPrivateAttachment(input, async () => reply(body, {
    headers: { "Content-Encoding": "gzip" },
  })), false)
})

test("refuse un flux en erreur ou bloqué, et expire avant même les en-têtes", async () => {
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("Erreur fictive")) },
  })
  assert.equal(await verifyPrivateAttachment(input, async () => reply(broken)), false)

  let cancelled = false
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  assert.equal(await verifyPrivateAttachment(input, async () => reply(stalled), 20), false)
  assert.equal(cancelled, true)

  let signal: AbortSignal | undefined
  assert.equal(await verifyPrivateAttachment(input, async (_target, options) => {
    signal = options.signal
    return new Promise<Response>(() => undefined)
  }, 20), false)
  assert.equal(signal?.aborted, true)
})

test("annule le corps d’une réponse reçue après expiration", async () => {
  let deliver!: (response: Response) => void
  let cancelled = false
  const response = new Promise<Response>((resolve) => { deliver = resolve })
  assert.equal(await verifyPrivateAttachment(input, () => response, 20), false)
  deliver(reply(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })))
  await Promise.resolve()
  assert.equal(cancelled, true)
})
