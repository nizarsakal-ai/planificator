import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import {
  deliverWorksitePhotos, deliveryBlock, deliverySnapshot, MAX_DELIVERY_BYTES,
  type DeliveryBatch, type DeliveryDeps, type DeliveryMessage,
} from "../../src/lib/worksite-photos/photo-delivery.service"

function fixture() {
  const bytes = Buffer.from("synthetic photo")
  const batch: DeliveryBatch = {
    worksiteName: "Chantier de test",
    recipients: [{ label: "Essai", email: "client@example.test" }, { label: null, email: "contact@example.test" }],
    photos: ["photo-1", "photo-2"].map((id) => ({
      id, driveFileId: id, mimeType: "image/jpeg", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), deliveryClaim: null,
    })),
  }
  const calls: string[] = []
  const messages: DeliveryMessage[] = []
  const deps: DeliveryDeps = {
    storage: {
      async download(companyId, fileId) {
        calls.push(`read:${companyId}:${fileId}`)
        return {
          stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }),
          contentType: "image/jpeg", contentLength: bytes.length,
        }
      },
    },
    async claim(snapshot) {
      if (snapshot !== deliverySnapshot(batch)) throw new Error("stale snapshot")
      calls.push("claim")
      return "batch-1"
    },
    async send(message, claim) {
      calls.push(`send:${claim}`)
      messages.push(message)
      return { acceptedId: "synthetic-receipt" }
    },
    async release(claim) { calls.push(`release:${claim}`) },
    async finish(claim, recipients, acceptedId) {
      calls.push(`finish:${claim}:${acceptedId}`)
      assert.deepEqual(recipients, batch.recipients.map(({ email }) => email))
    },
  }
  return { batch, deps, calls, messages, bytes }
}

test("sends one synthetic message containing every approved photo and reviewed recipient", async () => {
  const { batch, deps, calls, messages, bytes } = fixture()
  assert.deepEqual(await deliverWorksitePhotos("company-1", batch, deliverySnapshot(batch), deps), { photoCount: 2 })
  assert.deepEqual(calls, ["read:company-1:photo-1", "read:company-1:photo-2", "claim", "send:batch-1", "finish:batch-1:synthetic-receipt"])
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].to, ["client@example.test", "contact@example.test"])
  assert.deepEqual(messages[0].attachments.map(({ content }) => content), [bytes.toString("base64"), bytes.toString("base64")])
})

test("requires a fresh confirmation when a recipient or photo changes", async () => {
  const { batch, deps, calls } = fixture()
  const reviewed = deliverySnapshot(batch)
  batch.recipients[0].email = "other@example.test"
  await assert.rejects(deliverWorksitePhotos("company-1", batch, reviewed, deps), { code: "DELIVERY_CHANGED" })
  assert.deepEqual(calls, [])
  const fresh = deliverySnapshot(batch)
  batch.photos.pop()
  await assert.rejects(deliverWorksitePhotos("company-1", batch, fresh, deps), { code: "DELIVERY_CHANGED" })
  assert.deepEqual(calls, [])
})

test("a concurrent claim or a change during download stops the send", async () => {
  const { batch, deps, messages } = fixture()
  deps.claim = async () => { throw new Error("Conflict") }
  await assert.rejects(deliverWorksitePhotos("company-1", batch, deliverySnapshot(batch), deps), /Conflict/)
  assert.deepEqual(messages, [])
})

test("refuses empty, oversized, reserved and altered batches before mail", async () => {
  const { batch, deps, calls } = fixture()
  assert.equal(deliveryBlock({ ...batch, recipients: [] }), "DELIVERY_NO_RECIPIENTS")
  assert.equal(deliveryBlock({ ...batch, photos: [] }), "DELIVERY_NO_PHOTOS")
  batch.photos[0].sizeBytes = MAX_DELIVERY_BYTES + 1
  assert.equal(deliveryBlock(batch), "DELIVERY_TOO_LARGE")
  batch.photos[0].deliveryClaim = "batch-1"
  assert.equal(deliveryBlock(batch), "DELIVERY_PENDING")
  const altered = fixture()
  altered.batch.photos[0].sha256 = "bad-checksum"
  await assert.rejects(deliverWorksitePhotos("company-1", altered.batch, deliverySnapshot(altered.batch), altered.deps), { code: "PHOTO_CHECKSUM_MISMATCH" })
  assert.deepEqual(altered.calls, ["read:company-1:photo-1"])
  assert.deepEqual(calls, [])
})

test("a definite refusal releases the batch, an uncertain outcome never releases or finishes it", async () => {
  const { batch, deps, calls } = fixture()
  deps.send = async () => ({ rejected: true })
  await assert.rejects(deliverWorksitePhotos("company-1", batch, deliverySnapshot(batch), deps), { code: "DELIVERY_REJECTED" })
  assert.equal(calls.at(-1), "release:batch-1")
  calls.length = 0
  deps.send = async () => { throw new Error("Timeout") }
  await assert.rejects(deliverWorksitePhotos("company-1", batch, deliverySnapshot(batch), deps), { code: "DELIVERY_PENDING" })
  assert.equal(calls.at(-1), "claim")
})

test("an accepted message followed by a database failure remains reserved for reconciliation", async () => {
  const { batch, deps, calls } = fixture()
  deps.finish = async () => { throw new Error("Database unavailable") }
  await assert.rejects(deliverWorksitePhotos("company-1", batch, deliverySnapshot(batch), deps), { code: "DELIVERY_PENDING" })
  assert.equal(calls.at(-1), "send:batch-1")
})
