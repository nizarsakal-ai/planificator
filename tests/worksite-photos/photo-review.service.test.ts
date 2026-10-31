/**
 * LOT-ADMIN-REVIEW — service du contrôle Super Admin, base FACTICE en mémoire (données synthétiques).
 * La base factice sérialise les transactions (équivalent du verrou FOR UPDATE), annule les écritures d'une transaction en
 * échec et applique les mêmes refus que la garde SQL ; les preuves sur PostgreSQL réel sont dans admin-review.pg.test.ts.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import { approvePhoto, listReviewPhotos, trashPhoto } from "@/lib/worksite-photos/photo-review.service"
import type { PhotoSession } from "@/lib/worksite-photos/photo.service"
import { C1, C2, fakeDb, makeStore, photo, sa, storage, type Store } from "./review-fakes"

const codeOf = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e instanceof WorksitePhotoDomainError ? `${e.status}:${e.code}` : String(e) } }
const actions = (store: Store) => store.events.map((e) => e.action)

describe("autorité SUPER_ADMIN réelle (session ET base), aucune écriture sinon", () => {
  for (const [label, session, expected] of [
    ["sans session", null, "401:UNAUTHENTICATED"],
    ["EMPLOYEE", { user: { id: "u-x", role: "EMPLOYEE", companyId: C1 } }, "403:FORBIDDEN"],
    ["TEAM_LEADER", { user: { id: "u-x", role: "TEAM_LEADER", companyId: C1 } }, "403:FORBIDDEN"],
    ["ADMIN", { user: { id: "u-admin", role: "ADMIN", companyId: C1 } }, "403:FORBIDDEN"],
    ["session SUPER_ADMIN mais compte ADMIN en base", { user: { id: "u-admin", role: "SUPER_ADMIN", companyId: C1 } }, "403:FORBIDDEN"],
    ["SUPER_ADMIN sans entreprise", { user: { id: "u-sa", role: "SUPER_ADMIN", companyId: null } }, "403:FORBIDDEN"],
  ] as const) {
    it(`${label} ⇒ ${expected} sur la liste, la validation et la suppression`, async () => {
      const store = makeStore()
      store.photos.set("p1", photo("p1"))
      const st = storage()
      const deps = { reviewDb: fakeDb(store), storage: st.deps }
      assert.equal(await codeOf(listReviewPhotos(session as PhotoSession | null, { worksiteId: null, filter: null, cursor: null, limit: null }, deps)), expected)
      assert.equal(await codeOf(approvePhoto(session as PhotoSession | null, "p1", deps)), expected)
      assert.equal(await codeOf(trashPhoto(session as PhotoSession | null, "p1", deps)), expected)
      assert.equal(store.photos.get("p1")!.approvedAt, null)
      assert.equal(store.photos.get("p1")!.rejectRequestedAt, null)
      assert.deepEqual(st.calls, [])
      assert.deepEqual(store.events, [])
    })
  }
  it("compte désactivé ⇒ 401 ; entreprise désactivée ⇒ 403", async () => {
    const store = makeStore()
    store.photos.set("p1", photo("p1"))
    const deps = { reviewDb: fakeDb(store), storage: storage().deps }
    store.actors.set("u-sa", { ...store.actors.get("u-sa")!, active: false })
    assert.equal(await codeOf(approvePhoto(sa, "p1", deps)), "401:UNAUTHENTICATED")
    store.actors.set("u-sa", { ...store.actors.get("u-sa")!, active: true })
    store.companies.set(C1, { id: C1, active: false })
    assert.equal(await codeOf(approvePhoto(sa, "p1", deps)), "403:FORBIDDEN")
  })
  it("rétrogradé entre l'admission et la transaction ⇒ 403 relu sous verrou, aucune écriture", async () => {
    const store = makeStore()
    store.photos.set("p1", photo("p1"))
    const db = fakeDb(store, { beforeTx: () => store.actors.set("u-sa", { ...store.actors.get("u-sa")!, role: "ADMIN" }) })
    assert.equal(await codeOf(approvePhoto(sa, "p1", { reviewDb: db, storage: storage().deps })), "403:FORBIDDEN")
    assert.equal(store.photos.get("p1")!.approvedAt, null)
    assert.deepEqual(store.events, [])
  })
  it("photo d'une autre entreprise ou identifiant invalide ⇒ 404 uniforme, audité ACCESS_DENIED", async () => {
    const store = makeStore()
    store.photos.set("pB", photo("pB", { companyId: C2 }))
    const st = storage()
    const deps = { reviewDb: fakeDb(store), storage: st.deps }
    assert.equal(await codeOf(approvePhoto(sa, "pB", deps)), "404:PHOTO_NOT_FOUND")
    assert.equal(await codeOf(trashPhoto(sa, "pB", deps)), "404:PHOTO_NOT_FOUND")
    assert.equal(await codeOf(trashPhoto(sa, "x".repeat(65), deps)), "404:PHOTO_NOT_FOUND")
    assert.deepEqual(actions(store), ["ACCESS_DENIED", "ACCESS_DENIED", "ACCESS_DENIED"])
    assert.equal(store.photos.get("pB")!.status, "PENDING")
    assert.deepEqual(st.calls, [])
  })
})

describe("validation interne : attribuée, unique, n'envoie rien", () => {
  it("valide une fois, rejoue sans écriture ni second événement ; statut toujours PENDING", async () => {
    const store = makeStore()
    store.photos.set("p1", photo("p1"))
    const deps = { reviewDb: fakeDb(store), storage: storage().deps }
    const first = await approvePhoto(sa, "p1", deps)
    assert.equal(first.replayed, false)
    assert.equal(first.photo.approval.state, "APPROVED")
    assert.equal(first.photo.approval.byName, "Super Admin test")
    assert.equal(first.photo.delivery.state, "NOT_SENT")
    assert.equal(first.photo.status, "PENDING")
    const again = await approvePhoto(sa, "p1", deps)
    assert.equal(again.replayed, true)
    assert.deepEqual(actions(store), ["APPROVED"])
    assert.equal(JSON.stringify(first).includes("drive-"), false, "aucun identifiant Drive dans la réponse")
  })
  it("photo SENT legacy : validation refusée, rien n'est inventé ; photo supprimée : refusée", async () => {
    const store = makeStore()
    store.photos.set("ps", photo("ps", { status: "SENT", sentAt: new Date("2026-10-30T10:00:00.000Z") }))
    store.photos.set("pr", photo("pr", { status: "REJECTED", rejectRequestedAt: new Date(), rejectedAt: new Date() }))
    const deps = { reviewDb: fakeDb(store), storage: storage().deps }
    assert.equal(await codeOf(approvePhoto(sa, "ps", deps)), "409:PHOTO_NOT_PENDING")
    assert.equal(await codeOf(approvePhoto(sa, "pr", deps)), "409:PHOTO_REMOVED")
    assert.equal(store.photos.get("ps")!.approvedAt, null)
    assert.deepEqual(store.events, [])
  })
})

describe("suppression vers la corbeille Drive, deux phases idempotentes", () => {
  it("PENDING ⇒ REJECTED : intention attribuée, corbeille, finalisation ; un événement par phase ; rejeu sans effet", async () => {
    const store = makeStore()
    store.photos.set("p1", photo("p1"))
    const st = storage()
    const deps = { reviewDb: fakeDb(store), storage: st.deps }
    const result = await trashPhoto(sa, "p1", deps)
    assert.equal(result.photo.status, "REJECTED")
    assert.equal(result.photo.deletion.state, "TRASHED")
    assert.equal(result.photo.deletion.path, "REJECT")
    assert.equal(result.photo.deletion.byName, "Super Admin test")
    assert.equal(result.photo.delivery.state, "NOT_SENT")
    assert.deepEqual(st.calls, ["drive-p1"])
    assert.deepEqual(actions(store), ["REJECT_REQUESTED", "REJECTED"])
    const replay = await trashPhoto(sa, "p1", deps)
    assert.equal(replay.replayed, true)
    assert.deepEqual(st.calls, ["drive-p1"], "aucun nouvel appel Drive au rejeu")
    assert.deepEqual(actions(store), ["REJECT_REQUESTED", "REJECTED"])
  })
  it("SENT ⇒ DELETED par le cycle existant : preuve conservée, jamais REJECTED", async () => {
    const store = makeStore()
    const sentAt = new Date("2026-10-30T10:00:00.000Z")
    store.photos.set("ps", photo("ps", { status: "SENT", sentAt }))
    const st = storage()
    const result = await trashPhoto(sa, "ps", { reviewDb: fakeDb(store), storage: st.deps })
    assert.equal(result.photo.status, "DELETED")
    assert.equal(result.photo.deletion.path, "TRASH")
    assert.equal(result.photo.delivery.state, "SENT")
    assert.equal(result.photo.delivery.sentAt, sentAt.toISOString())
    assert.equal(result.photo.approval.state, "NOT_TRACKED")
    assert.deepEqual(actions(store), ["TRASH_REQUESTED", "TRASHED"])
  })
  it("panne Drive : intention conservée (« à reprendre »), validation bloquée ; la reprise finalise sans dupliquer l'audit", async () => {
    const store = makeStore()
    store.photos.set("p1", photo("p1"))
    const db = fakeDb(store)
    const failing = storage("fail")
    assert.equal(await codeOf(trashPhoto(sa, "p1", { reviewDb: db, storage: failing.deps })), "DriveProviderError: DRIVE_UNAVAILABLE")
    const stuck = store.photos.get("p1")!
    assert.equal(stuck.status, "PENDING")
    assert.ok(stuck.rejectRequestedAt)
    assert.equal(await codeOf(approvePhoto(sa, "p1", { reviewDb: db, storage: failing.deps })), "409:PHOTO_DELETION_IN_PROGRESS")
    const page = await listReviewPhotos(sa, { worksiteId: null, filter: null, cursor: null, limit: null }, { reviewDb: db, storage: failing.deps })
    assert.equal(page.photos[0].deletion.state, "TO_RESUME")
    const ok = storage()
    const resumed = await trashPhoto(sa, "p1", { reviewDb: db, storage: ok.deps })
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.photo.status, "REJECTED")
    assert.deepEqual(actions(store), ["REJECT_REQUESTED", "REJECTED"])
  })
  it("panne Drive après envoi : même reprise sur le chemin SENT → DELETED", async () => {
    const store = makeStore()
    store.photos.set("ps", photo("ps", { status: "SENT", sentAt: new Date() }))
    const db = fakeDb(store)
    await codeOf(trashPhoto(sa, "ps", { reviewDb: db, storage: storage("fail").deps }))
    assert.equal(store.photos.get("ps")!.status, "SENT")
    assert.ok(store.photos.get("ps")!.trashRequestedAt)
    const resumed = await trashPhoto(sa, "ps", { reviewDb: db, storage: storage().deps })
    assert.equal(resumed.photo.status, "DELETED")
    assert.deepEqual(actions(store), ["TRASH_REQUESTED", "TRASHED"])
  })
  it("fichier déjà absent côté Drive (404) : finalisé, FILE_MISSING journalisé une fois", async () => {
    const store = makeStore()
    store.photos.set("p1", photo("p1"))
    await trashPhoto(sa, "p1", { reviewDb: fakeDb(store), storage: storage("missing").deps })
    assert.equal(store.photos.get("p1")!.status, "REJECTED")
    assert.deepEqual(actions(store), ["REJECT_REQUESTED", "FILE_MISSING", "REJECTED"])
  })
  it("deux suppressions concurrentes : une intention, une finalisation, un événement de chaque", async () => {
    const store = makeStore()
    store.photos.set("p1", photo("p1"))
    const st = storage()
    const deps = { reviewDb: fakeDb(store), storage: st.deps }
    const [a, b] = await Promise.all([trashPhoto(sa, "p1", deps), trashPhoto(sa, "p1", deps)])
    assert.equal(a.photo.status, "REJECTED")
    assert.equal(b.photo.status, "REJECTED")
    assert.deepEqual(actions(store), ["REJECT_REQUESTED", "REJECTED"])
    assert.equal([a.replayed, b.replayed].filter(Boolean).length, 1)
  })
  it("validation et suppression concurrentes : état final cohérent, jamais validée après l'intention", async () => {
    for (const order of ["approve-first", "trash-first"] as const) {
      const store = makeStore()
      store.photos.set("p1", photo("p1"))
      const deps = { reviewDb: fakeDb(store), storage: storage().deps }
      const tasks = order === "approve-first" ? [approvePhoto(sa, "p1", deps), trashPhoto(sa, "p1", deps)] : [trashPhoto(sa, "p1", deps), approvePhoto(sa, "p1", deps)]
      const settled = await Promise.allSettled(tasks)
      const final = store.photos.get("p1")!
      assert.equal(final.status, "REJECTED", order)
      if (order === "approve-first") {
        assert.ok(final.approvedAt, "validée avant l'intention : validation conservée en historique")
        assert.deepEqual(actions(store), ["APPROVED", "REJECT_REQUESTED", "REJECTED"])
      } else {
        assert.equal(final.approvedAt, null)
        assert.equal(settled[1].status, "rejected")
        assert.deepEqual(actions(store), ["REJECT_REQUESTED", "REJECTED"])
      }
    }
  })
})

describe("galerie : pagination réelle au-delà de 50, filtre chantier et état", () => {
  it("60 photos ⇒ 3 pages de 24/24/12 sans doublon, ordre décroissant ; filtres", async () => {
    const store = makeStore()
    for (let i = 0; i < 60; i++) {
      store.photos.set(`p${String(i).padStart(2, "0")}`, photo(`p${String(i).padStart(2, "0")}`, {
        worksiteId: i % 2 === 0 ? "w1" : "w2", uploadedAt: new Date(Date.parse("2026-10-31T08:00:00.000Z") + Math.floor(i / 3) * 1000),
      }))
    }
    const deps = { reviewDb: fakeDb(store), storage: storage().deps }
    const seen: string[] = []
    let cursor: string | null = null
    const sizes: number[] = []
    do {
      const page: Awaited<ReturnType<typeof listReviewPhotos>> = await listReviewPhotos(sa, { worksiteId: null, filter: "ALL", cursor, limit: null }, deps)
      sizes.push(page.photos.length)
      seen.push(...page.photos.map((p) => p.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(sizes, [24, 24, 12])
    assert.equal(new Set(seen).size, 60)
    const w2 = await listReviewPhotos(sa, { worksiteId: "w2", filter: null, cursor: null, limit: "100" }, deps)
    assert.equal(w2.photos.length, 30)
    assert.ok(w2.photos.every((p) => p.worksite.id === "w2"))
    await approvePhoto(sa, "p00", deps)
    const toReview = await listReviewPhotos(sa, { worksiteId: null, filter: "to_review", cursor: null, limit: "100" }, deps)
    assert.equal(toReview.photos.length, 59)
    assert.equal(await codeOf(listReviewPhotos(sa, { worksiteId: null, filter: "nope", cursor: null, limit: null }, deps)), "400:INVALID_PAYLOAD")
    assert.equal(await codeOf(listReviewPhotos(sa, { worksiteId: null, filter: null, cursor: "%%%", limit: null }, deps)), "400:INVALID_PAYLOAD")
  })
})
