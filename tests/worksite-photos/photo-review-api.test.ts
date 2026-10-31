/**
 * LOT-ADMIN-REVIEW — handlers HTTP du contrôle Super Admin : drapeau, origine des mutations, codes stables, en-têtes privés,
 * corps sans identifiant ni chemin Drive, rejeu signalé, composition incomplète refusée (données synthétiques).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { handlePhotoApprove, handlePhotoTrash, handleReviewList, type PhotoApiDeps } from "@/lib/worksite-photos/photo.api"
import type { PhotoStoragePort } from "@/lib/worksite-photos/photo-storage.port"
import type { PhotoDb, PhotoSession } from "@/lib/worksite-photos/photo.service"
import { fakeDb, makeStore, photo, sa, type Store } from "./review-fakes"
import { testEnv } from "./test-env"

const ENV = testEnv({ PLANIFICATOR_WORKSITE_PHOTOS_ENABLED: "true" })
const ORIGIN = { host: "app.example.test", origin: "https://app.example.test" }
const URL_BASE = "https://app.example.test/api/worksite-photos"

function setup(session: PhotoSession | null, over: Partial<PhotoApiDeps> = {}) {
  const store: Store = makeStore()
  store.photos.set("p1", photo("p1"))
  store.photos.set("ps", photo("ps", { status: "SENT", sentAt: new Date("2026-10-30T10:00:00.000Z"), uploadedAt: new Date("2026-10-30T09:00:00.000Z") }))
  const trashCalls: string[] = []
  const storage = { trash: async (_c: string, id: string) => { trashCalls.push(id); return { missing: false } } } as unknown as PhotoStoragePort
  const deps: PhotoApiDeps = { auth: async () => session, db: {} as PhotoDb, reviewDb: fakeDb(store), storage, env: ENV, ...over }
  return { store, deps, trashCalls }
}

const post = (path: string, headers: Record<string, string> = ORIGIN) => new Request(`${URL_BASE}${path}`, { method: "POST", headers })

describe("routes de contrôle : enveloppe", () => {
  it("drapeau absent ⇒ 404 FEATURE_DISABLED sur les trois routes", async () => {
    const { deps } = setup(sa, { env: testEnv() })
    for (const res of [await handleReviewList(new Request(`${URL_BASE}/review`), deps), await handlePhotoApprove(post("/p1/approve"), "p1", deps), await handlePhotoTrash(post("/p1/trash"), "p1", deps)]) {
      assert.equal(res.status, 404)
      assert.deepEqual(await res.json(), { code: "FEATURE_DISABLED", error: "Introuvable" })
    }
  })
  it("mutation sans origine de confiance ⇒ 403 INVALID_ORIGIN, aucune écriture ni appel Drive", async () => {
    const { deps, store, trashCalls } = setup(sa)
    const approve = await handlePhotoApprove(post("/p1/approve", { host: "app.example.test", origin: "https://evil.example" }), "p1", deps)
    const trash = await handlePhotoTrash(post("/p1/trash", { host: "app.example.test", origin: "https://evil.example" }), "p1", deps)
    assert.equal(approve.status, 403)
    assert.equal(trash.status, 403)
    assert.equal((await approve.json()).code, "INVALID_ORIGIN")
    assert.equal(store.photos.get("p1")!.approvedAt, null)
    assert.equal(store.photos.get("p1")!.rejectRequestedAt, null)
    assert.deepEqual(trashCalls, [])
  })
  it("rôles non SUPER_ADMIN ⇒ 403 ; sans session ⇒ 401 ; réponses privées", async () => {
    const admin: PhotoSession = { user: { id: "u-admin", role: "ADMIN", companyId: "company-1" } }
    const { deps } = setup(admin)
    const res = await handlePhotoApprove(post("/p1/approve"), "p1", deps)
    assert.equal(res.status, 403)
    assert.equal(res.headers.get("cache-control"), "private, no-store")
    const anon = await handleReviewList(new Request(`${URL_BASE}/review`), setup(null).deps)
    assert.equal(anon.status, 401)
  })
  it("composition sans base de contrôle ⇒ 500 SERVER_ERROR (jamais un repli silencieux)", async () => {
    const { deps } = setup(sa, { reviewDb: undefined })
    const res = await handleReviewList(new Request(`${URL_BASE}/review`), deps)
    assert.equal(res.status, 500)
  })
})

describe("routes de contrôle : effets", () => {
  it("liste : filtre et curseur ; aucun identifiant ni chemin Drive dans le corps", async () => {
    const { deps } = setup(sa)
    const res = await handleReviewList(new Request(`${URL_BASE}/review?filter=ALL&limit=1`), deps)
    assert.equal(res.status, 200)
    const body = await res.json() as { photos: Array<{ id: string }>; nextCursor: string | null }
    assert.equal(body.photos.length, 1)
    assert.ok(body.nextCursor)
    assert.equal(/drive-|driveFileId|drivePath|googleapis/.test(JSON.stringify(body)), false)
    const next = await (await handleReviewList(new Request(`${URL_BASE}/review?filter=ALL&limit=1&cursor=${body.nextCursor}`), deps)).json() as { photos: Array<{ id: string }> }
    assert.notEqual(next.photos[0].id, body.photos[0].id)
    assert.equal((await handleReviewList(new Request(`${URL_BASE}/review?filter=bad`), deps)).status, 400)
  })
  it("valider puis rejouer : 200, Idempotency-Replayed false puis true, statut d'envoi inchangé", async () => {
    const { deps } = setup(sa)
    const first = await handlePhotoApprove(post("/p1/approve"), "p1", deps)
    assert.equal(first.status, 200)
    assert.equal(first.headers.get("idempotency-replayed"), "false")
    const body = await first.json() as { photo: { approval: { state: string }; delivery: { state: string } } }
    assert.equal(body.photo.approval.state, "APPROVED")
    assert.equal(body.photo.delivery.state, "NOT_SENT")
    const again = await handlePhotoApprove(post("/p1/approve"), "p1", deps)
    assert.equal(again.headers.get("idempotency-replayed"), "true")
  })
  it("valider une photo envoyée ⇒ 409 PHOTO_NOT_PENDING ; supprimer une photo envoyée ⇒ DELETED, preuve conservée", async () => {
    const { deps } = setup(sa)
    const refused = await handlePhotoApprove(post("/ps/approve"), "ps", deps)
    assert.equal(refused.status, 409)
    assert.deepEqual(await refused.json(), { code: "PHOTO_NOT_PENDING", error: "Photo déjà envoyée : validation impossible" })
    const trashed = await handlePhotoTrash(post("/ps/trash"), "ps", deps)
    assert.equal(trashed.status, 200)
    const body = await trashed.json() as { photo: { status: string; delivery: { state: string }; deletion: { path: string } } }
    assert.equal(body.photo.status, "DELETED")
    assert.equal(body.photo.delivery.state, "SENT")
    assert.equal(body.photo.deletion.path, "TRASH")
  })
  it("supprimer une photo non envoyée ⇒ REJECTED ; rejeu ⇒ Idempotency-Replayed true, un seul appel Drive", async () => {
    const { deps, trashCalls } = setup(sa)
    const res = await handlePhotoTrash(post("/p1/trash"), "p1", deps)
    assert.equal(res.status, 200)
    assert.equal((await res.json() as { photo: { status: string } }).photo.status, "REJECTED")
    const again = await handlePhotoTrash(post("/p1/trash"), "p1", deps)
    assert.equal(again.headers.get("idempotency-replayed"), "true")
    assert.deepEqual(trashCalls, ["drive-p1"])
  })
  it("panne Drive ⇒ 502 DRIVE_UNAVAILABLE public, intention conservée pour reprise", async () => {
    const { DriveProviderError } = await import("@/lib/worksite-photos/drive/drive.errors")
    const failing = { trash: async () => { throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true) } } as unknown as PhotoStoragePort
    const { deps, store } = setup(sa, { storage: failing })
    const res = await handlePhotoTrash(post("/p1/trash"), "p1", deps)
    assert.equal(res.status, 502)
    assert.deepEqual(await res.json(), { code: "DRIVE_UNAVAILABLE", error: "Stockage indisponible, réessayez" })
    assert.ok(store.photos.get("p1")!.rejectRequestedAt)
    assert.equal(store.photos.get("p1")!.status, "PENDING")
  })
})
