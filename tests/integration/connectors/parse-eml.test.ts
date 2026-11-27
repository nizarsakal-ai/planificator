import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { MAX_EML_BYTES, parseEml } from "../../../src/lib/integration/connectors/upload-eml/parse-eml"

const sender = "fictif@example.invalid"
const createMultipart = (count: number) => Buffer.from([
  `From: ${sender}`,
  "To: equipe@example.invalid",
  "Subject: =?UTF-8?Q?Pi=C3=A8ce_fictive?=",
  "Content-Type: multipart/mixed; boundary=fixture",
  "",
  "--fixture",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Texte de recette.",
  ...Array.from({ length: count }, () => [
    "--fixture",
    'Content-Type: application/pdf; name="fictif.pdf"',
    'Content-Disposition: attachment; filename="fictif.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERg==",
  ]).flat(),
  "--fixture--",
  "",
].join("\r\n"))

test("décode les en-têtes MIME, le texte et une pièce jointe, et hache les octets originaux", async () => {
  const raw = createMultipart(1)
  const result = await parseEml(raw)
  assert.ok(result.ok)
  assert.equal(result.message.sha256, createHash("sha256").update(raw).digest("hex"))
  assert.equal(result.message.senderAddress, sender)
  assert.deepEqual(result.message.recipientAddresses, ["equipe@example.invalid"])
  assert.equal(result.message.subject, "Pièce fictive")
  assert.equal(result.message.text.trim(), "Texte de recette.")
  assert.equal(result.message.attachments[0]?.filename, "fictif.pdf")
  assert.equal(result.message.attachments[0]?.mimeType, "application/pdf")
  assert.equal(Buffer.from(result.message.attachments[0].bytes).toString(), "%PDF")
})

test("refuse le dépassement des limites de fichier et de pièces jointes", async () => {
  assert.deepEqual(await parseEml(new Uint8Array(MAX_EML_BYTES + 1)), { ok: false, code: "EML_TOO_LARGE" })
  assert.equal((await parseEml(createMultipart(50))).ok, true)
  assert.deepEqual(await parseEml(createMultipart(51)), { ok: false, code: "EML_ATTACHMENT_LIMIT" })
})

test("refuse un en-tête absent, trop long ou un expéditeur ambigu", async () => {
  for (const raw of [
    "corps sans en-têtes",
    `From: ${sender}\nX-Test: ${"x".repeat(65536)}\n\nTexte`,
    `From: ${sender}\nFrom: autre@example.invalid\n\nTexte`,
    `From: ${sender}, autre@example.invalid\n\nTexte`,
  ]) {
    assert.deepEqual(await parseEml(Buffer.from(raw)), { ok: false, code: "EML_INVALID" })
  }
})

test("lit un courriel réparti sur plusieurs morceaux du flux", async () => {
  const { readEmlStream } = await import("../../../src/lib/integration/connectors/upload-eml/read-eml-stream")
  const raw = createMultipart(1)
  const result = await readEmlStream(new ReadableStream({
    start(controller) {
      controller.enqueue(raw.subarray(0, 10))
      controller.enqueue(raw.subarray(10))
      controller.close()
    },
  }))
  assert.ok(result.ok)
  assert.equal(result.message.sha256, createHash("sha256").update(raw).digest("hex"))
})

test("arrête la lecture dès que le flux dépasse le plafond", async () => {
  const { readEmlStream } = await import("../../../src/lib/integration/connectors/upload-eml/read-eml-stream")
  let cancelled = false
  const result = await readEmlStream(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_EML_BYTES))
      controller.enqueue(new Uint8Array(1))
    },
    cancel() { cancelled = true },
  }))
  assert.deepEqual(result, { ok: false, code: "EML_TOO_LARGE" })
  assert.equal(cancelled, true)
})
