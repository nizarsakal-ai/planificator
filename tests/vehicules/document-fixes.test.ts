import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { civilDate, computeDocumentStatus, dueReminders, getVehicleDocumentMaxBytes, HARD_DOCUMENT_MAX_BYTES, versionStatus } from "../../src/lib/vehicules/v3/document-domain"
import { readDocumentMultipart, handleDocumentUpload } from "../../src/lib/vehicules/v3/document-api"
import { effectiveReminderRole, readVerifiedDocumentBytes, type DocumentServiceDeps } from "../../src/lib/vehicules/v3/document-service"
import { v3JsonBody } from "../../src/lib/vehicules/v3/v3-http"
const bytes = new TextEncoder().encode("document privé"), sha256 = createHash("sha256").update(bytes).digest("hex")
const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close() } })
test("future validity is À venir in company civil date and historical remains historical", () => {
  const version = { verifiedAt: new Date(), validFrom: "2026-10-25", validUntil: "2026-11-01" }
  const today = civilDate(new Date("2026-10-24T23:30:00Z"), "Africa/Libreville")
  assert.equal(today, "2026-10-25")
  assert.equal(computeDocumentStatus({ archivedAt: null, currentVersion: version, today: "2026-10-24", thresholdsDays: [30, 7] }).status, "NOT_YET_VALID")
  assert.equal(versionStatus(version, "2026-10-24"), "NOT_YET_VALID")
  assert.equal(versionStatus(version, today), "VALID")
  assert.equal(versionStatus({ ...version, supersededAt: new Date() }, "2026-10-24"), "HISTORICAL")
  assert.equal(dueReminders([{ ...version, versionId: "v", documentId: "d", truckId: "t", supersededAt: null, archivedAt: null }], "2026-10-24", [30, 7]).length, 0)
})
test("document upload configuration has a hard memory cap and strict numeric configuration", () => {
  assert.equal(getVehicleDocumentMaxBytes({ NODE_ENV: "test", VEHICLE_DOCUMENT_MAX_BYTES: "999999999999" }), HARD_DOCUMENT_MAX_BYTES)
  assert.equal(getVehicleDocumentMaxBytes({ NODE_ENV: "test", VEHICLE_DOCUMENT_MAX_BYTES: "10x" }), HARD_DOCUMENT_MAX_BYTES)
  assert.equal(getVehicleDocumentMaxBytes({ NODE_ENV: "test", VEHICLE_DOCUMENT_MAX_BYTES: "1000" }), 1000)
})
test("JSON and multipart actual byte limits precede parsing even with lying content-length", async () => {
  await assert.rejects(v3JsonBody(new Request("https://test.local", { method: "POST", headers: { "Content-Length": "1" }, body: "x".repeat(33000) })), /PAYLOAD_TOO_LARGE/)
  await assert.rejects(v3JsonBody(new Request("https://test.local", { method: "POST", headers: { "Content-Length": "NaN" }, body: "{}" })), /INVALID_CONTENT_LENGTH/)
  await assert.rejects(readDocumentMultipart(new Request("https://test.local", { method: "POST", headers: { "Content-Length": "1", "Content-Type": "multipart/form-data; boundary=test" }, body: "x".repeat(66000) }), { NODE_ENV: "test", VEHICLE_DOCUMENT_MAX_BYTES: "10" }), /DOCUMENT_FILE_TOO_LARGE/)
})
test("bounded multipart still accepts a real private document form", async () => {
  const form = new FormData()
  form.set("payload", JSON.stringify({ category: "INSURANCE", title: "Police" }))
  form.set("file", new File([bytes], "assurance.pdf", { type: "application/pdf" }))
  const result = await readDocumentMultipart(new Request("https://test.local", { method: "POST", body: form }))
  assert.equal((result.body as { title: string }).title, "Police")
  assert.equal(result.file.filename, "assurance.pdf")
  assert.deepEqual(result.file.bytes, bytes)
})
test("unauthenticated multipart rejected before body getter or database", async () => {
  const old = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
  const request = new Request("https://test.local", { method: "POST", headers: { Origin: "https://test.local" }, body: "unread" })
  Object.defineProperty(request, "body", { get() { throw new Error("body must not be touched") } })
  try {
    const response = await handleDocumentUpload(request, "truck", { auth: async () => null, db: { $transaction: async () => { throw new Error("DB must not be touched") } } } as unknown as DocumentServiceDeps)
    assert.equal(response.status, 401)
  } finally { if (old === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = old }
})
test("private storage reads bounded to known immutable length and hash", async () => {
  const expected = { sizeBytes: bytes.byteLength, sha256 }
  assert.deepEqual(await readVerifiedDocumentBytes({ ok: true, status: 200, body: stream([bytes]), contentLength: null }, expected, 1024), bytes)
  await assert.rejects(readVerifiedDocumentBytes({ ok: true, status: 200, body: stream([bytes, bytes]), contentLength: null }, expected, 1024), /DOCUMENT_FILE_INTEGRITY/)
  await assert.rejects(readVerifiedDocumentBytes({ ok: true, status: 200, body: stream([bytes.subarray(1)]), contentLength: null }, expected, 1024), /DOCUMENT_FILE_INTEGRITY/)
  await assert.rejects(readVerifiedDocumentBytes({ ok: true, status: 200, body: stream([new Uint8Array(bytes.length)]), contentLength: bytes.length }, expected, 1024), /DOCUMENT_FILE_INTEGRITY/)
  await assert.rejects(readVerifiedDocumentBytes({ ok: true, status: 200, body: stream([bytes]), contentLength: bytes.length + 1 }, expected, 1024), /DOCUMENT_FILE_INTEGRITY/)
})
test("reminder role respects effective company membership and SUPER_ADMIN context", () => {
  const identity = { active: true, role: "ADMIN", companyId: "a" }
  assert.equal(effectiveReminderRole(identity, null, "a"), "ADMIN")
  assert.equal(effectiveReminderRole(identity, { active: false, role: "ADMIN" }, "a"), null)
  assert.equal(effectiveReminderRole(identity, { active: true, role: "EMPLOYEE" }, "a"), null)
  assert.equal(effectiveReminderRole({ ...identity, role: "SUPER_ADMIN" }, null, "a"), "SUPER_ADMIN")
  assert.equal(effectiveReminderRole({ ...identity, role: "SUPER_ADMIN", companyId: null }, null, "a"), null)
  assert.equal(effectiveReminderRole({ ...identity, role: "SUPER_ADMIN", companyId: null }, { active: true, role: "EMPLOYEE" }, "a"), "SUPER_ADMIN")
  assert.equal(effectiveReminderRole({ ...identity, role: "SUPER_ADMIN" }, { active: false, role: "ADMIN" }, "a"), null)
})
