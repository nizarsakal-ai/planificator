/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 3 — handlers HTTP : drapeau, origine, codes et corps sans fuite, en-têtes privés,
 * pré-autorisation AVANT lecture du corps (flux non consommé), multipart borné, Idempotency-Replayed, proxy.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { handleContextGet, handlePhotoFile, handlePhotoUpload, handlePhotosList, readPhotoMultipart, type PhotoApiDeps } from "@/lib/worksite-photos/photo.api"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import type { PhotoStoragePort } from "@/lib/worksite-photos/photo-storage.port"
import type { PhotoDb, PhotoSession } from "@/lib/worksite-photos/photo.service"

const ENV = { PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "true" }
const ORIGIN = { host: "app.example.test", origin: "https://app.example.test" }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])

/** Base factice minimale : un admin, une entreprise, un chantier, un engin ; les écritures sont mémorisées. */
function minimalDb(): PhotoDb & { state: { reservations: Record<string, unknown>[]; photos: Record<string, unknown>[] } } {
  const state = { reservations: [] as Record<string, unknown>[], photos: [] as Record<string, unknown>[] }
  const worksite = { id: "w1", name: "A", status: "IN_PROGRESS", companyId: "c1", clientName: "Cl" }
  const truck = { id: "t1", matricule: "AA-111-AA", active: true, companyId: "c1" }
  const reader = {
    findActor: async (id: string) => id === "u1" ? { id, name: "Admin", email: null, role: "ADMIN", companyId: "c1", active: true } : null,
    findCompany: async () => ({ id: "c1", active: true }),
    findEmployee: async () => null,
    findWorksites: async (q: { worksiteId?: string; companyId: string }) => (!q.worksiteId || q.worksiteId === "w1") && q.companyId === "c1" ? [worksite] : [],
  }
  return {
    state,
    ...reader,
    findTimezone: async () => "Europe/Paris",
    findTrucks: async (_c, truckId) => (!truckId || truckId === "t1") ? [truck] : [],
    createReservationIfAbsent: async (data) => { const row = { id: "res-1", driveFileCreatedAt: null, abandonedAt: null, ...(data as object) }; state.reservations.push(row); return row as never },
    findReservationByKey: async () => (state.reservations[0] as never) ?? null,
    reservationCas: async (where, data) => { const r = state.reservations[0] as Record<string, unknown> | undefined; if (!r || r.state !== where.state) return 0; Object.assign(r, data); return 1 },
    findPhotos: async ({ photoId }) => state.photos.filter((p) => !photoId || p.id === photoId) as never,
    createEvent: async () => null,
    transaction: async (fn) => fn({
      ...reader,
      lockWorksiteAndTruck: async () => ({ worksite, truck }),
      reservationCas: async (where, data) => { const r = state.reservations[0] as Record<string, unknown>; if (r.state !== where.state) return 0; Object.assign(r, data); return 1 },
      createPhoto: async (data) => { const row = { ...(data as object), uploadedAt: new Date(), sentAt: null, trashedAt: null }; state.photos.push(row); return row as never },
      createEvent: async () => null,
    }),
  }
}

const storage: PhotoStoragePort = {
  provider: "drive",
  preallocateFileId: async () => "drive-1",
  resolveFolders: async (_c, i) => ({ dayFolderId: "day", worksiteLabel: i.worksiteLabel, dayLabel: i.dayLabel }),
  createFile: async (_c, i) => ({ created: true, info: { id: i.id, size: i.bytes.byteLength, md5: null, trashed: false } }),
  getFile: async () => null,
  download: async () => ({ stream: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("img")); c.close() } }), contentType: "image/jpeg", contentLength: 3 }),
  trash: async () => undefined,
  delete: async () => undefined,
}

function deps(session: PhotoSession | null, over: Partial<PhotoApiDeps> = {}): PhotoApiDeps {
  return { auth: async () => session, db: minimalDb(), storage, env: ENV, clock: () => new Date("2026-10-30T10:00:00Z"), ...over }
}
const admin: PhotoSession = { user: { id: "u1", role: "ADMIN", companyId: "c1" } }

function multipart(parts: Array<{ name: string; value: string | Uint8Array; filename?: string; type?: string }>, extraHeaders: Record<string, string> = {}): Request {
  const form = new FormData()
  for (const p of parts) typeof p.value === "string" ? form.append(p.name, p.value) : form.append(p.name, new Blob([p.value], { type: p.type ?? "image/jpeg" }), p.filename ?? "photo.jpg")
  return new Request("https://app.example.test/api/worksite-photos/worksites/w1/trucks/t1", { method: "POST", headers: { ...ORIGIN, "Idempotency-Key": "11111111-1111-4111-8111-111111111111", ...extraHeaders }, body: form })
}

describe("enveloppe commune", () => {
  it("drapeau absent ⇒ 404 FEATURE_DISABLED ; sans session ⇒ 401 ; en-têtes privés ; aucun détail interne", async () => {
    const off = await handleContextGet(new Request("https://app.example.test/api/worksite-photos/context"), deps(admin, { env: {} }))
    assert.equal(off.status, 404)
    assert.deepEqual(await off.json(), { code: "FEATURE_DISABLED", error: "Introuvable" })
    const anon = await handleContextGet(new Request("https://app.example.test/api/worksite-photos/context"), deps(null))
    assert.equal(anon.status, 401)
    assert.equal(anon.headers.get("cache-control"), "private, no-store")
  })
  it("contexte : chantiers et engins pour l'acteur", async () => {
    const res = await handleContextGet(new Request("https://app.example.test/api/worksite-photos/context"), deps(admin))
    assert.equal(res.status, 200)
    const body = (await res.json()) as { role: string; worksites: unknown[]; trucks: unknown[] }
    assert.equal(body.role, "ADMIN")
    assert.equal(body.worksites.length, 1)
    assert.equal(body.trucks.length, 1)
  })
})

describe("POST upload", () => {
  it("origine étrangère ⇒ 403 avant tout traitement", async () => {
    const req = multipart([{ name: "payload", value: JSON.stringify({ phase: "BEFORE" }) }, { name: "file", value: JPEG }], { origin: "https://evil.example.test" })
    const res = await handlePhotoUpload(req, { worksiteId: "w1", truckId: "t1" }, deps(admin))
    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { code: string }).code, "INVALID_ORIGIN")
  })
  it("pré-autorisation refusée ⇒ le flux n'est PAS consommé (chantier inconnu, engin inconnu)", async () => {
    let read = false
    // highWaterMark 0 : `pull` ne se déclenche que sur une lecture effective (jamais à la construction).
    const body = new ReadableStream<Uint8Array>({ pull() { read = true } }, { highWaterMark: 0 })
    const req = new Request("https://app.example.test/api/x", { method: "POST", headers: { ...ORIGIN, "Content-Type": "multipart/form-data; boundary=x" }, body, duplex: "half" } as RequestInit)
    const res = await handlePhotoUpload(req, { worksiteId: "w-inconnu", truckId: "t1" }, deps(admin))
    assert.equal(res.status, 404)
    assert.equal(((await res.json()) as { code: string }).code, "WORKSITE_NOT_FOUND")
    assert.equal(read, false, "aucun octet lu")
    const res2 = await handlePhotoUpload(multipart([{ name: "payload", value: "{}" }, { name: "file", value: JPEG }]), { worksiteId: "w1", truckId: "t-inconnu" }, deps(admin))
    assert.equal(res2.status, 404)
  })
  it("nominal ⇒ 201, reçu sans identifiant Drive, Idempotency-Replayed=false ; rejeu ⇒ 201 Idempotency-Replayed=true", async () => {
    const d = deps(admin)
    const build = () => multipart([{ name: "payload", value: JSON.stringify({ phase: "BEFORE", worksiteId: "w1", truckId: "t1" }) }, { name: "file", value: JPEG, filename: "IMG.jpg" }])
    const res = await handlePhotoUpload(build(), { worksiteId: "w1", truckId: "t1" }, d)
    assert.equal(res.status, 201)
    assert.equal(res.headers.get("idempotency-replayed"), "false")
    const receipt = (await res.json()) as Record<string, unknown>
    assert.deepEqual(Object.keys(receipt).sort(), ["drivePath", "photoId", "status"])
    assert.equal(JSON.stringify(receipt).includes("drive-1"), false)
    const again = await handlePhotoUpload(build(), { worksiteId: "w1", truckId: "t1" }, d)
    assert.equal(again.status, 201)
    assert.equal(again.headers.get("idempotency-replayed"), "true")
  })
  it("multipart : payload manquant/doublé/champ inconnu ⇒ 400 ; non-multipart ⇒ 400 ; fichier trop grand ⇒ 413 avant fin de lecture ; mauvais type ⇒ 415", async () => {
    const d = deps(admin)
    assert.equal((await handlePhotoUpload(multipart([{ name: "file", value: JPEG }]), { worksiteId: "w1", truckId: "t1" }, d)).status, 400)
    assert.equal((await handlePhotoUpload(multipart([{ name: "payload", value: "{}" }, { name: "payload", value: "{}" }, { name: "file", value: JPEG }]), { worksiteId: "w1", truckId: "t1" }, d)).status, 400)
    assert.equal((await handlePhotoUpload(multipart([{ name: "payload", value: "{}" }, { name: "file", value: JPEG }, { name: "extra", value: "x" }]), { worksiteId: "w1", truckId: "t1" }, d)).status, 400)
    const notMultipart = new Request("https://app.example.test/api/x", { method: "POST", headers: { ...ORIGIN, "Content-Type": "application/json" }, body: "{}" })
    assert.equal((await handlePhotoUpload(notMultipart, { worksiteId: "w1", truckId: "t1" }, d)).status, 400)
    const big = new Uint8Array(1024 * 1024 + 10); big.set(JPEG)
    const tooBig = await handlePhotoUpload(multipart([{ name: "payload", value: JSON.stringify({ phase: "BEFORE" }) }, { name: "file", value: big }]), { worksiteId: "w1", truckId: "t1" }, deps(admin, { env: { ...ENV, WORKSITE_PHOTOS_MAX_BYTES: String(1024 * 1024) } }))
    assert.equal(tooBig.status, 413)
    assert.equal(((await tooBig.json()) as { code: string }).code, "PHOTO_FILE_TOO_LARGE")
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0])
    const wrongType = await handlePhotoUpload(multipart([{ name: "payload", value: JSON.stringify({ phase: "BEFORE" }) }, { name: "file", value: pdf, filename: "a.pdf", type: "application/pdf" }]), { worksiteId: "w1", truckId: "t1" }, d)
    assert.equal(wrongType.status, 415)
  })
  it("readPhotoMultipart : payload > 32 Kio ⇒ 413 PAYLOAD_TOO_LARGE", async () => {
    const req = multipart([{ name: "payload", value: "x".repeat(33 * 1024) }, { name: "file", value: JPEG }])
    await assert.rejects(readPhotoMultipart(req, ENV), (e: unknown) => e instanceof WorksitePhotoDomainError && e.code === "PAYLOAD_TOO_LARGE")
  })
})

describe("GET liste et proxy", () => {
  it("liste : limit borné, corps sans identifiant Drive ; proxy : en-têtes de sécurité et flux", async () => {
    const d = deps(admin)
    await handlePhotoUpload(multipart([{ name: "payload", value: JSON.stringify({ phase: "AFTER" }) }, { name: "file", value: JPEG }]), { worksiteId: "w1", truckId: "t1" }, d)
    const list = await handlePhotosList(new Request("https://app.example.test/api/worksite-photos?limit=5000"), d)
    assert.equal(list.status, 200)
    const body = (await list.json()) as { photos: Array<{ id: string }> }
    assert.equal(body.photos.length, 1)
    assert.equal(JSON.stringify(body).includes("drive-1"), false)
    const file = await handlePhotoFile(new Request(`https://app.example.test/api/worksite-photos/${body.photos[0].id}/file`), body.photos[0].id, d)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get("content-type"), "image/jpeg")
    assert.equal(file.headers.get("x-content-type-options"), "nosniff")
    assert.equal(file.headers.get("content-security-policy"), "default-src 'none'; sandbox")
    assert.equal(file.headers.get("cache-control"), "private, no-store")
    assert.equal(file.headers.get("content-length"), String(JPEG.byteLength), "taille vérifiée à l'upload, pas celle annoncée par le fournisseur")
    assert.equal(await file.text(), "img")
    const missing = await handlePhotoFile(new Request("https://app.example.test/api/worksite-photos/nope/file"), "nope", d)
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as { code: string }).code, "PHOTO_NOT_FOUND")
  })
})
