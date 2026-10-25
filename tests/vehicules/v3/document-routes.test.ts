// V3 Lot 1 — routes HTTP sur double mémoire : drapeau, origine, multipart, en-têtes privés, proxy fichier.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { GET as listGet, POST as uploadPost } from "@/app/api/trucks/[id]/documents/route"
import { GET as detailGet, PATCH as metadataPatch } from "@/app/api/trucks/[id]/documents/[documentId]/route"
import { POST as replacePost } from "@/app/api/trucks/[id]/documents/[documentId]/versions/route"
import { POST as verifyPost } from "@/app/api/trucks/[id]/documents/[documentId]/verify/route"
import { POST as archivePost } from "@/app/api/trucks/[id]/documents/[documentId]/archive/route"
import { GET as fileGet } from "@/app/api/trucks/[id]/documents/[documentId]/versions/[versionId]/file/route"
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/vehicle-documents/reminder-settings/route"
import { GET as cronGet } from "@/app/api/cron/vehicle-document-reminders/route"
import { ADMIN, LEADER, MemoryDocumentStorage, PDF_BYTES, PNG_BYTES, TRUCK, V3MemoryDb, key, streamToBuffer } from "./v3-test-db"

const ORIGIN = "https://vehicles-tests.invalid"
const headers = (extra: Record<string, string> = {}) => ({ host: "vehicles-tests.invalid", origin: ORIGIN, ...extra })
const params = (values: Record<string, string>) => ({ params: Promise.resolve({ id: TRUCK, documentId: "", versionId: "", ...values }) })

function multipart(payload: unknown, file: { name: string; type: string; bytes: Uint8Array } | null, idempotencyKey: string | null = key(), extra: Record<string, string> = {}) {
  const body = new FormData()
  body.set("payload", JSON.stringify(payload))
  if (file) body.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }), file.name)
  return new Request(`${ORIGIN}/api/trucks/${TRUCK}/documents`, { method: "POST", headers: headers({ ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}), ...extra }), body })
}
const json = (method: string, body: unknown, extra: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/x`, { method, headers: headers({ "Content-Type": "application/json", ...extra }), body: JSON.stringify(body) })
const get = (path = "/api/x") => new Request(`${ORIGIN}${path}`, { method: "GET", headers: headers() })
const pdf = { name: "assurance.pdf", type: "application/pdf", bytes: PDF_BYTES }
const payload = async (response: Response) => response.json() as Promise<Record<string, unknown>>

let savedFlag: string | undefined
before(() => { savedFlag = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
after(() => { if (savedFlag === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedFlag })

describe("V3 routes documents", () => {
  it("prototype désactivé : toutes les routes répondent 404 sans toucher la base", async () => {
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "false"
    const db = new V3MemoryDb()
    const responses = await Promise.all([
      listGet(get(), params({}), db.deps()),
      uploadPost(multipart({ category: "INSURANCE", title: "x" }, pdf), params({}), db.deps()),
      settingsGet(get(), undefined, db.deps()),
      fileGet(get(), params({ documentId: "d", versionId: "v" }), db.deps()),
    ])
    for (const response of responses) { assert.equal(response.status, 404); assert.equal((await payload(response)).code, "FEATURE_DISABLED") }
    assert.equal(db.calls.length, 0)
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
  })

  it("ajout multipart : 201 + reçu + replay ; origine étrangère, fichier absent ou type refusé → aucune écriture", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    const deps = db.deps(ADMIN, storage)
    const k = key()
    const created = await uploadPost(multipart({ category: "INSURANCE", title: "Attestation", validUntil: "2026-12-31" }, pdf, k), params({}), deps)
    assert.equal(created.status, 201)
    assert.equal(created.headers.get("Cache-Control"), "private, no-store")
    assert.equal(created.headers.get("Idempotency-Replayed"), "false")
    const receipt = await payload(created)
    assert.deepEqual(Object.keys(receipt).sort(), ["documentId", "revision", "versionId", "versionNumber"])
    const replay = await uploadPost(multipart({ category: "INSURANCE", title: "Attestation", validUntil: "2026-12-31" }, pdf, k), params({}), deps)
    assert.equal(replay.status, 201)
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true")
    assert.deepEqual(await payload(replay), receipt)

    const foreign = await uploadPost(multipart({ category: "INSURANCE", title: "x" }, pdf, key(), { origin: "https://evil.invalid" }), params({}), deps)
    assert.equal(foreign.status, 403)
    assert.equal((await payload(foreign)).code, "INVALID_ORIGIN")
    const noKey = await uploadPost(multipart({ category: "INSURANCE", title: "x" }, pdf, null), params({}), deps)
    assert.equal((await payload(noKey)).code, "INVALID_IDEMPOTENCY_KEY")
    const noFile = await uploadPost(multipart({ category: "INSURANCE", title: "x" }, null), params({}), deps)
    assert.equal((await payload(noFile)).code, "INVALID_PAYLOAD")
    const wrongType = await uploadPost(multipart({ category: "INSURANCE", title: "x" }, { name: "x.pdf", type: "application/pdf", bytes: PNG_BYTES }), params({}), deps)
    assert.equal(wrongType.status, 415)
    const notMultipart = await uploadPost(json("POST", { category: "INSURANCE", title: "x" }, { "Idempotency-Key": key() }), params({}), deps)
    assert.equal((await payload(notMultipart)).code, "INVALID_PAYLOAD")
    const tooLarge = await uploadPost(multipart({ category: "INSURANCE", title: "x" }, pdf, key(), { "content-length": String(200 * 1024 * 1024) }), params({}), deps)
    assert.equal(tooLarge.status, 413)
    const leader = await uploadPost(multipart({ category: "INSURANCE", title: "x" }, pdf), params({}), db.deps(LEADER, storage))
    assert.equal(leader.status, 403)
    assert.equal(storage.stored.length, 1)
    assert.equal(db.state.vehicleDocumentVersion.length, 1)
  })

  it("liste, détail, validation, remplacement, archivage et proxy fichier avec en-têtes privés", async () => {
    const db = new V3MemoryDb()
    const storage = new MemoryDocumentStorage()
    const deps = db.deps(ADMIN, storage)
    const receipt = await payload(await uploadPost(multipart({ category: "REPAIR_MAINTENANCE", title: "Facture 2019", issuedOn: "2019-01-10" }, pdf), params({}), deps))
    const documentId = String(receipt.documentId)
    const list = await listGet(get(), params({}), deps)
    assert.equal(list.status, 200)
    const listBody = await payload(list)
    assert.equal((listBody.documents as unknown[]).length, 1)
    for (const forbidden of ["storageKey", "requestHash", "idempotencyKey", "companyId", "signature"]) assert.equal(JSON.stringify(listBody).includes(`"${forbidden}"`), false, forbidden)

    const verify = await verifyPost(json("POST", { expectedRevision: 1, versionId: receipt.versionId }), params({ documentId }), deps)
    assert.equal(verify.status, 200)
    assert.equal((await payload(verify)).revision, 2)
    const injected = await verifyPost(json("POST", { expectedRevision: 2, versionId: receipt.versionId, companyId: "other" }), params({ documentId }), deps)
    assert.equal((await payload(injected)).code, "INVALID_PAYLOAD")
    const malformed = await verifyPost(new Request(`${ORIGIN}/x`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: "{" }), params({ documentId }), deps)
    assert.equal((await payload(malformed)).code, "INVALID_JSON")

    const replaced = await replacePost(multipart({ expectedRevision: 2, mileage: 95000 }, { ...pdf, name: "facture-2.pdf" }), params({ documentId }), deps)
    assert.equal(replaced.status, 201)
    const second = await payload(replaced)
    assert.equal(second.versionNumber, 2)
    const detail = await payload(await detailGet(get(), params({ documentId }), deps))
    assert.equal((detail.versions as unknown[]).length, 2)

    const file = await fileGet(get(`/api/trucks/${TRUCK}/documents/${documentId}/versions/${receipt.versionId}/file?dl=1`), params({ documentId, versionId: String(receipt.versionId) }), deps)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get("Content-Type"), "application/pdf")
    assert.equal(file.headers.get("Content-Disposition"), "attachment; filename*=UTF-8''assurance.pdf")
    assert.equal(file.headers.get("Cache-Control"), "private, no-store")
    assert.equal(file.headers.get("X-Content-Type-Options"), "nosniff")
    assert.ok(file.headers.get("Content-Security-Policy")?.includes("sandbox"))
    assert.deepEqual([...(await streamToBuffer(file.body as ReadableStream<Uint8Array>))], [...PDF_BYTES])
    const inline = await fileGet(get(), params({ documentId, versionId: String(second.versionId) }), deps)
    assert.ok(inline.headers.get("Content-Disposition")?.startsWith("inline;"))
    const missing = await fileGet(get(), params({ documentId, versionId: "absent" }), deps)
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get("Cache-Control"), "private, no-store")

    const archived = await archivePost(json("POST", { expectedRevision: 3, reason: "Doublon" }), params({ documentId }), deps)
    assert.equal(archived.status, 200)
    assert.equal((await payload(archived)).revision, 4)
    const stale = await archivePost(json("POST", { expectedRevision: 1, reason: "Encore" }), params({ documentId }), deps)
    assert.equal(stale.status, 409)
  })

  it("camion archivé : validation et archivage autorisés, rejeu exact conservé, nouveaux fichiers refusés", async () => {
    const db = new V3MemoryDb(), storage = new MemoryDocumentStorage(), deps = db.deps(ADMIN, storage)
    const receipt = await payload(await uploadPost(multipart({ category: "INSURANCE", title: "Ancien contrat" }, pdf), params({}), deps))
    const documentId = String(receipt.documentId)
    db.state.trucks.find(truck => truck.id === TRUCK)!.active = false
    assert.equal((await uploadPost(multipart({ category: "INSURANCE", title: "Nouveau" }, pdf), params({}), deps)).status, 409)
    assert.equal((await replacePost(multipart({ expectedRevision: 1 }, pdf), params({ documentId }), deps)).status, 409)
    const verified = await verifyPost(json("POST", { expectedRevision: 1, versionId: receipt.versionId }), params({ documentId }), deps)
    assert.equal(verified.status, 200)
    const command = { expectedRevision: 2, reason: "Contrat résilié" }
    const archived = await payload(await archivePost(json("POST", command), params({ documentId }), deps))
    assert.equal(archived.revision, 3)
    const auditCount = db.state.vehicleAuditLog.length
    const replay = await archivePost(json("POST", command), params({ documentId }), deps)
    assert.equal(replay.status, 200)
    assert.equal((await payload(replay)).replayed, true)
    assert.equal(db.state.vehicleAuditLog.length, auditCount)
    const mismatch = await archivePost(json("POST", { ...command, reason: "Autre motif" }), params({ documentId }), deps)
    assert.equal(mismatch.status, 409)
    assert.equal((await payload(mismatch)).code, "DOCUMENT_ARCHIVED")
    assert.equal((await verifyPost(json("POST", { expectedRevision: 3, versionId: receipt.versionId }), params({ documentId }), deps)).status, 409)
  })

  it("seuils de rappel : lecture/écriture administrateur ; cron protégé par secret, drapeau et résumé sans secret", async () => {
    const db = new V3MemoryDb()
    const deps = db.deps()
    assert.deepEqual(await payload(await settingsGet(get(), undefined, deps)), { thresholdsDays: [30, 7], revision: 0, timezone: "Europe/Paris" })
    const put = await settingsPut(json("PUT", { thresholdsDays: [45, 10], expectedRevision: 0 }), undefined, deps)
    assert.equal(put.status, 200)
    assert.deepEqual(await payload(put), { thresholdsDays: [45, 10], revision: 1 })
    assert.equal((await settingsPut(json("PUT", { thresholdsDays: [45], expectedRevision: 0 }), undefined, db.deps(LEADER))).status, 403)

    const savedSecret = process.env.CRON_SECRET
    process.env.CRON_SECRET = "test-cron-secret"
    const unauthorized = await cronGet(new Request(`${ORIGIN}/api/cron/vehicle-document-reminders`), undefined, { db: db as never })
    assert.equal(unauthorized.status, 401)
    const authorized = await cronGet(new Request(`${ORIGIN}/api/cron/vehicle-document-reminders`, { headers: { authorization: "Bearer test-cron-secret" } }), undefined, { db: db as never, clock: () => db.now })
    assert.equal(authorized.status, 200)
    assert.deepEqual(await payload(authorized), { companies: 0, created: 0, alreadySent: 0, candidates: 0 })
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "false"
    const disabled = await cronGet(new Request(`${ORIGIN}/api/cron/vehicle-document-reminders`, { headers: { authorization: "Bearer test-cron-secret" } }), undefined, { db: db as never })
    assert.equal(disabled.status, 404)
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
    if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret
  })

  it("une panne technique renvoie 500 sans détail et sans cache", async () => {
    const db = new V3MemoryDb()
    db.failOnce = { operation: "vehicleDocument.findMany", error: new Error("postgresql://user:secret@db/prod exploded") }
    const response = await listGet(get(), params({}), db.deps())
    assert.equal(response.status, 500)
    assert.equal(response.headers.get("Cache-Control"), "private, no-store")
    const body = await payload(response)
    assert.deepEqual(body, { code: "SERVER_ERROR", error: "Erreur serveur" })
  })
})


describe("V3 PATCH métadonnées sans fichier",()=>{
 it("validation explicite JSON crée une version privée non vérifiée et le rejeu identique répond 200",async()=>{
  const db=new V3MemoryDb(),storage=new MemoryDocumentStorage(),deps=db.deps(ADMIN,storage);
  const first=await payload(await uploadPost(multipart({category:"TECHNICAL_INSPECTION",title:"CT"},pdf),params({}),deps));const documentId=String(first.documentId);
  assert.equal((await verifyPost(json("POST",{expectedRevision:1,versionId:first.versionId}),params({documentId}),deps)).status,200);
  const k=key(),body={expectedRevision:2,title:"Contrôle technique complet",issuedOn:"2026-10-01",validUntil:"2027-10-01",observations:"Informations complétées après dépôt"};
  const request=()=>json("PATCH",body,{"Idempotency-Key":k});const response=await metadataPatch(request(),params({documentId}),deps);
  assert.equal(response.status,201);assert.equal(response.headers.get("Cache-Control"),"private, no-store");assert.equal(response.headers.get("Idempotency-Replayed"),"false");const result=await payload(response);assert.equal(result.versionNumber,2);assert.equal(result.revision,3);
  const replay=await metadataPatch(request(),params({documentId}),deps);assert.equal(replay.status,200);assert.equal(replay.headers.get("Idempotency-Replayed"),"true");assert.deepEqual(await payload(replay),result);
  const current=db.state.vehicleDocumentVersion.find(v=>v.id===result.versionId)!;assert.equal(current.verifiedAt,null);assert.equal(storage.stored.length,2);
  const conflict=await metadataPatch(json("PATCH",{...body,title:"Autre"},{"Idempotency-Key":k}),params({documentId}),deps);assert.equal(conflict.status,409);assert.equal((await payload(conflict)).code,"IDEMPOTENCY_CONFLICT");
 });
 it("origine étrangère et rôle lecture seule refusés sans lire le corps ni le fichier",async()=>{
  const db=new V3MemoryDb(),storage=new MemoryDocumentStorage(),deps=db.deps(ADMIN,storage);
  const first=await payload(await uploadPost(multipart({category:"INSURANCE",title:"Assurance"},pdf),params({}),deps));let reads=0;
  for(const [origin,actor] of [["https://evil.invalid",ADMIN],[ORIGIN,LEADER]] as const){const request=json("PATCH",{expectedRevision:1},{origin,"Idempotency-Key":key()});Object.defineProperty(request,"body",{get(){reads++;throw Error("body must remain unread")}});const r=await metadataPatch(request,params({documentId:String(first.documentId)}),db.deps(actor,storage));assert.equal(r.status,403)}
  assert.equal(reads,0);assert.equal(storage.signed.length,0);assert.equal(storage.stored.length,1);
 });
});
