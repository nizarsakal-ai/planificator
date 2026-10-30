/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 3 — service d'upload avec base et stockage factices :
 * droits (rôles, visibilité D8, cross-tenant, archivés), réservation (rejeu, en cours, reprise, abandon),
 * création Drive idempotente, transaction, aucune suppression Drive depuis le chemin de requête.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import { DriveProviderError } from "@/lib/worksite-photos/drive/drive.errors"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import type { PhotoStoragePort, StoredFileInfo } from "@/lib/worksite-photos/photo-storage.port"
import {
  authorizeUploadTarget, listPhotos, listUploadContext, openPhotoFile, resolveActor, uploadPhoto,
  type ActorRow, type EmployeeRow, type PhotoDb, type PhotoRow, type PhotoSession, type PhotoTx, type ReservationRow, type TruckRow, type WorksiteRow,
} from "@/lib/worksite-photos/photo.service"

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3])
const KEY = "11111111-1111-4111-8111-111111111111"
const NOW = new Date("2026-10-30T10:00:00.000Z")
const C1 = "c1", C2 = "c2"

function fakeDb() {
  const state = {
    users: [
      { id: "u-admin", name: "Admin A", email: "a@x.test", role: "ADMIN", companyId: C1, active: true },
      { id: "u-emp", name: null, email: "e@x.test", role: "EMPLOYEE", companyId: C1, active: true },
      { id: "u-lead", name: null, email: "l@x.test", role: "TEAM_LEADER", companyId: C1, active: true },
      { id: "u-off", name: null, email: "o@x.test", role: "EMPLOYEE", companyId: C1, active: false },
    ] as ActorRow[],
    companies: [{ id: C1, active: true }, { id: C2, active: true }],
    employees: {
      [`u-emp:${C1}`]: { id: "emp-1", firstName: "Eva", lastName: "Ouvrière", active: true, role: "EMPLOYEE", ledTeamIds: [] },
      [`u-lead:${C1}`]: { id: "emp-2", firstName: "Léo", lastName: "Chef", active: true, role: "TEAM_LEADER", ledTeamIds: ["team-1"] },
    } as Record<string, EmployeeRow>,
    worksites: [
      { id: "w1", name: "Chantier A", status: "IN_PROGRESS", companyId: C1, clientName: "Lauralu", assignedEmployees: ["emp-1"], teams: ["team-1"] },
      { id: "w2", name: "Chantier B", status: "PLANNED", companyId: C1, clientName: "Autre", assignedEmployees: [], teams: ["team-9"] },
      { id: "w-arch", name: "Vieux", status: "ARCHIVED", companyId: C1, clientName: "Lauralu", assignedEmployees: ["emp-1"], teams: ["team-1"] },
      { id: "w-c2", name: "Ailleurs", status: "IN_PROGRESS", companyId: C2, clientName: "X", assignedEmployees: [], teams: [] },
    ],
    trucks: [
      { id: "t1", matricule: "AA-111-AA", active: true, companyId: C1 }, { id: "t-off", matricule: "BB-222-BB", active: false, companyId: C1 }, { id: "t-c2", matricule: "CC-333-CC", active: true, companyId: C2 },
    ] as TruckRow[],
    reservations: [] as ReservationRow[],
    photos: [] as PhotoRow[],
    events: [] as Record<string, unknown>[],
    locks: [] as string[],
    seq: 0,
    timezone: "Europe/Paris",
  }
  const visibleWorksites = (q: Parameters<PhotoDb["findWorksites"]>[0]) => state.worksites.filter((w) => w.companyId === q.companyId
    && (!q.worksiteId || w.id === q.worksiteId) && (!q.excludeArchived || w.status !== "ARCHIVED")
    && (q.visibility.kind === "all" || (q.visibility.kind === "employee" && w.assignedEmployees.includes(q.visibility.employeeId)) || (q.visibility.kind === "teams" && w.teams.some((t) => q.visibility.kind === "teams" && q.visibility.teamIds.includes(t)))))
    .map<WorksiteRow>(({ id, name, status, companyId, clientName }) => ({ id, name, status, companyId, clientName }))
  // CAS factice fidèle à la base : condition `driveFileCreatedAt: null` honorée, et le déclencheur SQL
  // `worksite_photo_upload_reservations_timestamps_check` (horodatage posé immuable) reproduit par une exception.
  const cas = async (where: { id: string; companyId: string; state: string; attemptGeneration: number; driveFileCreatedAt?: null }, data: Record<string, unknown>) => {
    const row = state.reservations.find((r) => r.id === where.id && r.companyId === where.companyId && r.state === where.state && r.attemptGeneration === where.attemptGeneration
      && (where.driveFileCreatedAt !== null || r.driveFileCreatedAt === null))
    if (!row) return 0
    if ("driveFileCreatedAt" in data && row.driveFileCreatedAt !== null && data.driveFileCreatedAt !== row.driveFileCreatedAt) throw new Error("worksite_photo_upload_reservations_timestamps_check")
    Object.assign(row, data)
    return 1
  }
  const reader = {
    findActor: async (id: string) => state.users.find((u) => u.id === id) ?? null,
    findCompany: async (id: string) => state.companies.find((c) => c.id === id) ?? null,
    findEmployee: async (userId: string, companyId: string) => state.employees[`${userId}:${companyId}`] ?? null,
    findWorksites: async (q: Parameters<PhotoDb["findWorksites"]>[0]) => visibleWorksites(q).slice(0, q.take ?? 200),
  }
  const tx: PhotoTx = {
    ...reader,
    lockWorksiteAndTruck: async (companyId, worksiteId, truckId) => {
      state.locks.push(`${worksiteId}+${truckId}`)
      const w = state.worksites.find((x) => x.id === worksiteId && x.companyId === companyId)
      return { worksite: w ? { id: w.id, name: w.name, status: w.status, companyId: w.companyId, clientName: w.clientName } : null, truck: state.trucks.find((t) => t.id === truckId && t.companyId === companyId) ?? null }
    },
    reservationCas: cas,
    createPhoto: async (data) => { const row = { ...(data as object), uploadedAt: NOW, sentAt: null, trashedAt: null } as PhotoRow; state.photos.push(row); return row },
    createEvent: async (data) => { state.events.push(data as Record<string, unknown>); return null },
  }
  const db: PhotoDb = {
    ...reader,
    findTimezone: async () => state.timezone,
    findTrucks: async (companyId, truckId) => state.trucks.filter((t) => t.companyId === companyId && (!truckId || t.id === truckId)),
    createReservationIfAbsent: async (data) => {
      const d = data as Omit<ReservationRow, "id" | "driveFileCreatedAt" | "abandonedAt">
      if (state.reservations.some((r) => r.companyId === d.companyId && r.idempotencyKey === d.idempotencyKey)) return null
      const row: ReservationRow = { id: `res-${++state.seq}`, driveFileCreatedAt: null, abandonedAt: null, ...d }
      state.reservations.push(row)
      return row
    },
    findReservationByKey: async (companyId, key) => { const r = state.reservations.find((x) => x.companyId === companyId && x.idempotencyKey === key); return r ? { ...r } : null },
    reservationCas: cas,
    findPhotos: async ({ companyId, worksiteIds, photoId, take }) => state.photos.filter((p) => p.companyId === companyId && (!photoId || p.id === photoId) && (!worksiteIds || worksiteIds.includes(p.worksiteId))).slice(0, take),
    createEvent: async (data) => { state.events.push(data as Record<string, unknown>); return null },
    transaction: async (fn) => fn(tx),
  }
  return { db, state }
}

function fakeStorage(options: { existing?: Map<string, StoredFileInfo> } = {}) {
  const files = options.existing ?? new Map<string, StoredFileInfo>()
  const calls: string[] = []
  let ids = 0
  const storage: PhotoStoragePort = {
    provider: "drive",
    preallocateFileId: async () => { calls.push("preallocate"); return `drive-${++ids}` },
    resolveFolders: async (_c, input) => { calls.push(`folders:${input.worksiteLabel}/${input.dayLabel}@${input.day.toISOString()}`); return { dayFolderId: "day-folder", worksiteLabel: input.worksiteLabel, dayLabel: input.dayLabel } },
    createFile: async (_c, input) => {
      calls.push(`create:${input.id}:${input.name}`)
      if (files.has(input.id)) return { created: false, info: null }
      const info = { id: input.id, size: input.bytes.byteLength, md5: createHash("md5").update(input.bytes).digest("hex"), trashed: false }
      files.set(input.id, info)
      return { created: true, info }
    },
    getFile: async (_c, id) => { calls.push(`get:${id}`); return files.get(id) ?? null },
    download: async (_c, id) => { calls.push(`download:${id}`); return { stream: new ReadableStream(), contentType: "image/jpeg", contentLength: files.get(id)?.size ?? null } },
    trash: async (_c, id) => { calls.push(`trash:${id}`) },
    delete: async (_c, id) => { calls.push(`delete:${id}`) },
  }
  return { storage, calls, files }
}

const session = (id: string, role: string, companyId: string | null = C1): PhotoSession => ({ user: { id, role, companyId } })
const file = { filename: "IMG_0001.jpg", declaredMimeType: "image/jpeg", bytes: JPEG }
const payload = { phase: "BEFORE" as const }

async function expectCode(promise: Promise<unknown>, code: string, status?: number) {
  try { await promise } catch (error) {
    if (error instanceof WorksitePhotoDomainError) { assert.equal(error.code, code); if (status) assert.equal(error.status, status); return }
    throw error
  }
  throw new Error(`attendu ${code}`)
}

describe("acteur et droits", () => {
  it("CLIENT, session sans entreprise, compte inactif, rôle de session ≠ rôle effectif", async () => {
    const { db } = fakeDb(); const { storage } = fakeStorage(); const deps = { db, storage, clock: () => NOW }
    await expectCode(resolveActor(null, deps), "UNAUTHENTICATED", 401)
    await expectCode(resolveActor(session("u-admin", "CLIENT"), deps), "FORBIDDEN", 403)
    await expectCode(resolveActor(session("u-admin", "ADMIN", null), deps), "FORBIDDEN", 403)
    await expectCode(resolveActor(session("u-off", "EMPLOYEE"), deps), "UNAUTHENTICATED", 401)
    await expectCode(resolveActor(session("u-emp", "ADMIN"), deps), "FORBIDDEN", 403, )
    const emp = await resolveActor(session("u-emp", "EMPLOYEE"), deps)
    assert.deepEqual(emp.visibility, { kind: "employee", employeeId: "emp-1" })
    assert.equal(emp.displayName, "Eva Ouvrière")
    const lead = await resolveActor(session("u-lead", "TEAM_LEADER"), deps)
    assert.deepEqual(lead.visibility, { kind: "teams", teamIds: ["team-1"] })
  })
  it("visibilité D8 : employé = chantiers affectés ; chef = chantiers de son équipe ; admin = tous ; archivés exclus du contexte", async () => {
    const { db } = fakeDb(); const { storage } = fakeStorage(); const deps = { db, storage, clock: () => NOW }
    assert.deepEqual((await listUploadContext(session("u-emp", "EMPLOYEE"), deps)).worksites.map((w) => w.id), ["w1"])
    assert.deepEqual((await listUploadContext(session("u-lead", "TEAM_LEADER"), deps)).worksites.map((w) => w.id), ["w1"])
    const admin = await listUploadContext(session("u-admin", "ADMIN"), deps)
    assert.deepEqual(admin.worksites.map((w) => w.id), ["w1", "w2"])
    assert.deepEqual(admin.trucks.map((t) => t.id), ["t1"], "engins actifs seulement")
  })
  it("pré-autorisation : chantier non visible ou autre tenant ⇒ 404 ; archivé ⇒ 409 ; engin absent/autre tenant ⇒ 404 ; inactif ⇒ 409", async () => {
    const { db } = fakeDb(); const { storage } = fakeStorage(); const deps = { db, storage, clock: () => NOW }
    await expectCode(authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w2", truckId: "t1" }, deps), "WORKSITE_NOT_FOUND", 404)
    await expectCode(authorizeUploadTarget(session("u-admin", "ADMIN"), { worksiteId: "w-c2", truckId: "t1" }, deps), "WORKSITE_NOT_FOUND", 404)
    await expectCode(authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w-arch", truckId: "t1" }, deps), "WORKSITE_ARCHIVED", 409)
    await expectCode(authorizeUploadTarget(session("u-admin", "ADMIN"), { worksiteId: "w1", truckId: "t-c2" }, deps), "TRUCK_NOT_FOUND", 404)
    await expectCode(authorizeUploadTarget(session("u-admin", "ADMIN"), { worksiteId: "w1", truckId: "t-off" }, deps), "TRUCK_ARCHIVED", 409)
    const ok = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    assert.equal(ok.worksite.clientName, "Lauralu")
  })
})

describe("upload", () => {
  async function setup() {
    const { db, state } = fakeDb(); const { storage, calls, files } = fakeStorage()
    const deps = { db, storage, clock: () => NOW, env: {} as NodeJS.ProcessEnv }
    const target = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    return { db, state, storage, calls, files, deps, target }
  }
  it("chemin nominal : réservation, identifiant préalloué, dossier du jour, création, COMMITTED, photo PENDING, événements, aucune suppression", async () => {
    const { state, calls, deps, target } = await setup()
    const receipt = await uploadPhoto(target, file, payload, KEY, deps)
    assert.equal(receipt.replayed, false)
    assert.equal(receipt.status, "PENDING")
    assert.match(receipt.drivePath, /^\/Chantiers\/Lauralu-Chantier A~w1\/2026-10-30\/20261030-110000_AA-111-AA_AVANT_[a-z0-9]{8}\.jpg$/)
    const reservation = state.reservations[0]
    assert.equal(reservation.state, "COMMITTED")
    assert.equal(reservation.driveFileId, "drive-1")
    assert.equal(state.photos[0].id, reservation.photoId)
    assert.equal(state.photos[0].driveFileId, "drive-1")
    assert.equal(state.photos[0].uploadedByNameSnapshot, "Eva Ouvrière")
    assert.deepEqual(calls, ["preallocate", "folders:Lauralu-Chantier A~w1/2026-10-30@2026-10-30T00:00:00.000Z", `create:drive-1:${receipt.drivePath.split("/").pop()}`])
    assert.deepEqual(state.events.map((e) => e.action), ["RESERVED", "UPLOADED"])
    assert.deepEqual(state.locks, ["w1+t1"])
    assert.equal(calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false)
  })
  it("rejeu de la même clé : même reçu, aucun nouvel appel au stockage ; autre fichier ⇒ 409 IDEMPOTENCY_CONFLICT", async () => {
    const { calls, deps, target } = await setup()
    const first = await uploadPhoto(target, file, payload, KEY, deps)
    calls.length = 0
    const again = await uploadPhoto(target, file, payload, KEY, deps)
    assert.deepEqual([again.photoId, again.replayed], [first.photoId, true])
    assert.deepEqual(calls, [])
    await expectCode(uploadPhoto(target, { ...file, bytes: new Uint8Array([...JPEG, 9]) }, payload, KEY, deps), "IDEMPOTENCY_CONFLICT", 409)
    await expectCode(uploadPhoto(target, file, { phase: "AFTER" }, KEY, deps), "IDEMPOTENCY_CONFLICT", 409)
  })
  it("payload incohérent, clé absente, fichier non image, checksum faux ⇒ refus AVANT toute réservation", async () => {
    const { state, calls, deps, target } = await setup()
    await expectCode(uploadPhoto(target, file, { phase: "BEFORE", worksiteId: "w2" }, KEY, deps), "PAYLOAD_MISMATCH", 400)
    await expectCode(uploadPhoto(target, file, payload, null, deps), "IDEMPOTENCY_KEY_REQUIRED", 400)
    await expectCode(uploadPhoto(target, { ...file, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }, payload, KEY, deps), "PHOTO_TYPE_NOT_ALLOWED", 415)
    await expectCode(uploadPhoto(target, file, { phase: "BEFORE", clientSha256: "0".repeat(64) }, KEY, deps), "PHOTO_CHECKSUM_MISMATCH", 400)
    assert.equal(state.reservations.length, 0)
    assert.deepEqual(calls, [])
  })
  it("réservation détenue par une autre tentative, bail non expiré ⇒ 409 UPLOAD_IN_PROGRESS sans appel au stockage", async () => {
    const { state, calls, deps, target } = await setup()
    state.reservations.push({ id: "res-x", companyId: C1, idempotencyKey: KEY, requestHash: "", worksiteId: "w1", truckId: "t1", uploadedById: "u-emp", photoId: "p-x", driveFileId: "drive-x", state: "UPLOADING", attemptGeneration: 1, attemptOwner: "other", leaseExpiresAt: new Date(NOW.getTime() + 60_000), driveFileCreatedAt: null, abandonedAt: null })
    // même empreinte que la requête courante
    const probe = await uploadPhoto(target, file, payload, "22222222-2222-4222-8222-222222222222", deps).catch(() => null)
    state.reservations[0].requestHash = state.reservations[1].requestHash
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "UPLOAD_IN_PROGRESS", 409)
    assert.ok(probe)
    assert.equal(calls.filter((c) => c.startsWith("create:drive-x")).length, 0)
  })
  it("bail expiré : reprise par CAS (génération + 1), même identifiant Drive ; 409 fournisseur ⇒ fichier existant vérifié ; publication", async () => {
    const { state, calls, files, deps, target } = await setup()
    const expiredRow: ReservationRow = { id: "res-old", companyId: C1, idempotencyKey: KEY, requestHash: "", worksiteId: "w1", truckId: "t1", uploadedById: "u-emp", photoId: "p-old", driveFileId: "drive-old", state: "UPLOADING", attemptGeneration: 1, attemptOwner: "other", leaseExpiresAt: new Date(NOW.getTime() - 1), driveFileCreatedAt: null, abandonedAt: null }
    state.reservations.push(expiredRow)
    const probe = await uploadPhoto(target, file, payload, "33333333-3333-4333-8333-333333333333", deps)
    expiredRow.requestHash = state.reservations.find((r) => r.photoId === probe.photoId)!.requestHash
    // L'ancienne tentative avait déjà créé le fichier (résultat inconnu côté serveur) :
    files.set("drive-old", { id: "drive-old", size: JPEG.byteLength, md5: createHash("md5").update(JPEG).digest("hex"), trashed: false })
    calls.length = 0
    const receipt = await uploadPhoto(target, file, payload, KEY, deps)
    assert.equal(receipt.photoId, "p-old")
    assert.equal(expiredRow.state, "COMMITTED")
    assert.equal(expiredRow.attemptGeneration, 2)
    assert.ok(calls.includes("create:drive-old:" + receipt.drivePath.split("/").pop()))
    assert.ok(calls.includes("get:drive-old"), "409 fournisseur ⇒ contrôle du fichier existant")
    assert.equal(calls.includes("preallocate"), false, "aucun nouvel identifiant : même fichier")
  })
  it("fichier existant d'un contenu différent sous notre identifiant ⇒ 409 UPLOAD_ABORTED, réservation ABANDONED, événement, aucune suppression", async () => {
    const { state, calls, files, deps, target } = await setup()
    const expiredRow: ReservationRow = { id: "res-old", companyId: C1, idempotencyKey: KEY, requestHash: "", worksiteId: "w1", truckId: "t1", uploadedById: "u-emp", photoId: "p-old", driveFileId: "drive-old", state: "UPLOADING", attemptGeneration: 1, attemptOwner: "other", leaseExpiresAt: new Date(NOW.getTime() - 1), driveFileCreatedAt: null, abandonedAt: null }
    state.reservations.push(expiredRow)
    const probe = await uploadPhoto(target, file, payload, "33333333-3333-4333-8333-333333333333", deps)
    expiredRow.requestHash = state.reservations.find((r) => r.photoId === probe.photoId)!.requestHash
    files.set("drive-old", { id: "drive-old", size: 1, md5: "ff", trashed: false })
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "UPLOAD_ABORTED", 409)
    assert.equal(expiredRow.state, "ABANDONED")
    assert.ok(expiredRow.abandonedAt)
    assert.ok(state.events.some((e) => e.action === "UPLOAD_ABORTED"))
    assert.equal(calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false)
  })
  it("échec du stockage AVANT rattachement ⇒ bail libéré (pas d'attente du TTL), réservation UPLOADING ; le nouvel essai de la même clé reprend et aboutit", async () => {
    const { state, calls, deps, target } = await setup()
    let failures = 1
    const originalCreate = deps.storage.createFile
    deps.storage.createFile = async (c, i) => { if (failures-- > 0) throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true, 503, "backend") ; return originalCreate(c, i) }
    const error = await uploadPhoto(target, file, payload, KEY, deps).catch((e: unknown) => e)
    assert.equal((error as { code?: string }).code, "DRIVE_UNAVAILABLE")
    const row = state.reservations[0]
    assert.equal(row.state, "UPLOADING")
    assert.ok(row.leaseExpiresAt.getTime() <= NOW.getTime(), "bail libéré")
    assert.equal(calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false)
    // Réessai immédiat (bouton « Réessayer ») : reprise par CAS, même identifiant Drive, publication.
    const receipt = await uploadPhoto(target, file, payload, KEY, deps)
    assert.equal(receipt.replayed, false)
    assert.equal(row.state, "COMMITTED")
    assert.equal(row.attemptGeneration, 2)
    assert.equal(state.photos[0].driveFileId, "drive-1")
    assert.equal(calls.filter((c) => c === "preallocate").length, 1, "un seul identifiant Drive pour la clé")
  })
  it("L2-R5 propagé : 409 Drive non reconnu à la création du fichier ⇒ 409 UPLOAD_ABORTED, réservation ABANDONED, événement, aucune suppression", async () => {
    const { state, calls, deps, target } = await setup()
    deps.storage.createFile = async () => { throw new DriveProviderError("DRIVE_CONFLICT", 409, false, 409, "unrelatedConflict") }
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "UPLOAD_ABORTED", 409)
    assert.equal(state.reservations[0].state, "ABANDONED")
    assert.ok(state.events.some((e) => e.action === "UPLOAD_ABORTED" && (e.detail as Record<string, unknown>).reason === "unrelatedConflict"))
    assert.equal(state.photos.length, 0)
    assert.equal(calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false)
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "UPLOAD_ABORTED", 409)
  })
  it("réservation ABANDONED/CLEANING/CLOSED ⇒ 409 UPLOAD_ABORTED, nouvelle clé requise", async () => {
    const { state, deps, target } = await setup()
    for (const st of ["ABANDONED", "CLEANING", "CLOSED"] as const) {
      state.reservations.length = 0
      const probe = await uploadPhoto(target, file, payload, "44444444-4444-4444-8444-444444444444", deps)
      const row = state.reservations.find((r) => r.photoId === probe.photoId)!
      state.photos.length = 0
      row.state = st
      await expectCode(uploadPhoto(target, file, payload, "44444444-4444-4444-8444-444444444444", deps), "UPLOAD_ABORTED", 409)
    }
  })
  it("échec applicatif au commit (chantier archivé entre-temps) ⇒ réservation ABANDONED, aucune suppression Drive, erreur métier", async () => {
    const { state, calls, deps, target } = await setup()
    const archive = () => { state.worksites[0].status = "ARCHIVED" }
    // archive juste avant la transaction : on détourne resolveFolders pour déclencher l'archivage après la pré-autorisation
    const original = deps.storage.resolveFolders
    deps.storage.resolveFolders = async (c, i) => { archive(); return original(c, i) }
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "WORKSITE_ARCHIVED", 409)
    assert.equal(state.reservations[0].state, "ABANDONED")
    assert.ok(state.reservations[0].abandonedAt)
    assert.equal(calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false, "le chemin de requête ne supprime jamais sur Drive")
    assert.equal(state.photos.length, 0)
  })
  it("CAS de commit perdu ⇒ 409 UPLOAD_SUPERSEDED, événement, aucune compensation", async () => {
    const { state, calls, deps, target } = await setup()
    const originalTx = deps.db.transaction
    deps.db.transaction = async (fn) => originalTx(async (tx) => {
      // une autre tentative a repris la réservation pendant l'upload
      const row = state.reservations[0]; row.attemptGeneration += 1
      return fn(tx)
    })
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "UPLOAD_SUPERSEDED", 409)
    assert.ok(state.events.some((e) => e.action === "UPLOAD_SUPERSEDED"))
    assert.equal(state.photos.length, 0)
    assert.equal(calls.some((c) => c.startsWith("delete")), false)
  })
})

describe("relecture des droits dans la transaction (L3-R1)", () => {
  async function setupWithHook(hook: (state: ReturnType<typeof fakeDb>["state"]) => void) {
    const { db, state } = fakeDb(); const { storage, calls } = fakeStorage()
    const deps = { db, storage, clock: () => NOW, env: {} as NodeJS.ProcessEnv }
    const target = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    // Révocation entre l'admission et la transaction (pendant les appels Drive).
    const original = storage.resolveFolders
    storage.resolveFolders = async (c, i) => { hook(state); return original(c, i) }
    const error = await uploadPhoto(target, file, payload, KEY, deps).catch((e: unknown) => e)
    return { state, calls, error }
  }
  const expectRefused = (r: Awaited<ReturnType<typeof setupWithHook>>, code: string) => {
    assert.ok(r.error instanceof WorksitePhotoDomainError, "erreur métier attendue")
    assert.equal(r.error.code, code)
    assert.equal(r.state.photos.length, 0, "aucune photo")
    assert.equal(r.state.reservations[0].state, "ABANDONED", "tentative abandonnée par CAS (D18)")
    assert.equal(r.calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false, "aucune suppression Drive")
  }
  it("affectation retirée du chantier ⇒ 404, aucune photo, réservation ABANDONED", async () => {
    expectRefused(await setupWithHook((st) => { st.worksites[0].assignedEmployees = [] }), "WORKSITE_NOT_FOUND")
  })
  it("compte désactivé ⇒ 401 ; entreprise désactivée ⇒ 403 ; fiche employé désactivée ⇒ 403", async () => {
    expectRefused(await setupWithHook((st) => { st.users.find((u) => u.id === "u-emp")!.active = false }), "UNAUTHENTICATED")
    expectRefused(await setupWithHook((st) => { st.companies[0].active = false }), "FORBIDDEN")
    expectRefused(await setupWithHook((st) => { st.employees[`u-emp:${C1}`].active = false }), "FORBIDDEN")
  })
  it("rôle changé sur la fiche (EMPLOYEE → TEAM_LEADER) ⇒ 403 ; fiche supprimée ⇒ 403", async () => {
    expectRefused(await setupWithHook((st) => { st.employees[`u-emp:${C1}`].role = "TEAM_LEADER" }), "FORBIDDEN")
    expectRefused(await setupWithHook((st) => { delete st.employees[`u-emp:${C1}`] }), "FORBIDDEN")
  })
  it("chef d'équipe : son équipe retirée du chantier entre admission et publication ⇒ 404", async () => {
    const { db, state } = fakeDb(); const { storage } = fakeStorage()
    const deps = { db, storage, clock: () => NOW, env: {} as NodeJS.ProcessEnv }
    const target = await authorizeUploadTarget(session("u-lead", "TEAM_LEADER"), { worksiteId: "w1", truckId: "t1" }, deps)
    const original = storage.resolveFolders
    storage.resolveFolders = async (c, i) => { state.worksites[0].teams = ["team-9"]; return original(c, i) }
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "WORKSITE_NOT_FOUND", 404)
    assert.equal(state.photos.length, 0)
  })
  it("sans révocation, la photo porte le nom relu en transaction et la réservation est COMMITTED", async () => {
    const { db, state } = fakeDb(); const { storage } = fakeStorage()
    const deps = { db, storage, clock: () => NOW, env: {} as NodeJS.ProcessEnv }
    const target = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    const original = storage.resolveFolders
    storage.resolveFolders = async (c, i) => { state.employees[`u-emp:${C1}`].lastName = "Renommée"; return original(c, i) }
    await uploadPhoto(target, file, payload, KEY, deps)
    assert.equal(state.photos[0].uploadedByNameSnapshot, "Eva Renommée")
    assert.equal(state.reservations[0].state, "COMMITTED")
  })
})

describe("reprise avec horodatage de création déjà posé (L3-R2)", () => {
  it("bail expiré, driveFileCreatedAt non nul, fichier existant conforme ⇒ publication, horodatage initial inchangé", async () => {
    const { db, state } = fakeDb(); const { storage, files } = fakeStorage()
    const deps = { db, storage, clock: () => NOW, env: {} as NodeJS.ProcessEnv }
    const target = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    const createdAt = new Date("2026-10-30T09:50:00.000Z")
    const row: ReservationRow = { id: "res-old", companyId: C1, idempotencyKey: KEY, requestHash: "", worksiteId: "w1", truckId: "t1", uploadedById: "u-emp", photoId: "p-old", driveFileId: "drive-old", state: "UPLOADING", attemptGeneration: 1, attemptOwner: "other", leaseExpiresAt: new Date(NOW.getTime() - 1), driveFileCreatedAt: createdAt, abandonedAt: null }
    state.reservations.push(row)
    const probe = await uploadPhoto(target, file, payload, "33333333-3333-4333-8333-333333333333", deps)
    row.requestHash = state.reservations.find((r) => r.photoId === probe.photoId)!.requestHash
    files.set("drive-old", { id: "drive-old", size: JPEG.byteLength, md5: createHash("md5").update(JPEG).digest("hex"), trashed: false })
    const receipt = await uploadPhoto(target, file, payload, KEY, deps)
    assert.equal(receipt.photoId, "p-old")
    assert.equal(row.state, "COMMITTED")
    assert.equal(row.attemptGeneration, 2)
    assert.equal(row.driveFileCreatedAt, createdAt, "première valeur conservée")
  })
  it("génération perdue pendant la création Drive ⇒ aucun horodatage écrit par la tentative périmée, UPLOAD_SUPERSEDED", async () => {
    const { db, state } = fakeDb(); const { storage } = fakeStorage()
    const deps = { db, storage, clock: () => NOW, env: {} as NodeJS.ProcessEnv }
    const target = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    const original = storage.createFile
    storage.createFile = async (c, i) => { state.reservations[0].attemptGeneration += 1; return original(c, i) }
    await expectCode(uploadPhoto(target, file, payload, KEY, deps), "UPLOAD_SUPERSEDED", 409)
    assert.equal(state.reservations[0].driveFileCreatedAt, null)
    assert.equal(state.photos.length, 0)
  })
})

describe("jour civil du dossier (L3-R3)", () => {
  async function folderCallFor(instant: string, timezone: string) {
    const { db, state } = fakeDb(); const { storage, calls } = fakeStorage()
    state.timezone = timezone
    const deps = { db, storage, clock: () => new Date(instant), env: {} as NodeJS.ProcessEnv }
    const target = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    const receipt = await uploadPhoto(target, file, payload, KEY, deps)
    return { folders: calls.find((c) => c.startsWith("folders:"))!, drivePath: receipt.drivePath }
  }
  it("identité DATE et libellé désignent le même jour civil de l'entreprise, avant et après minuit, été/hiver, décalage négatif", async () => {
    const cases: Array<[string, string, string]> = [
      ["2026-10-30T12:00:00.000Z", "Europe/Paris", "2026-10-30"],
      ["2026-10-30T23:30:00.000Z", "Europe/Paris", "2026-10-31"], // sonde Codex : 23 h 30 UTC = 00 h 30 à Paris le lendemain
      ["2026-10-30T22:59:59.000Z", "Europe/Paris", "2026-10-30"],
      ["2026-10-24T22:30:00.000Z", "Europe/Paris", "2026-10-25"], // dernier jour d'heure d'été (UTC+2)
      ["2026-10-25T23:30:00.000Z", "Europe/Paris", "2026-10-26"], // heure d'hiver (UTC+1)
      ["2026-10-30T01:00:00.000Z", "America/Sao_Paulo", "2026-10-29"], // décalage négatif : encore la veille
      ["2026-10-30T12:00:00.000Z", "UTC", "2026-10-30"],
    ]
    for (const [instant, tz, day] of cases) {
      const r = await folderCallFor(instant, tz)
      assert.equal(r.folders, `folders:Lauralu-Chantier A~w1/${day}@${day}T00:00:00.000Z`, `${instant} ${tz}`)
      assert.match(r.drivePath, new RegExp(`/${day}/`), `${instant} ${tz}`)
    }
  })
})

describe("lectures et proxy", () => {
  it("liste paginée limitée aux chantiers visibles ; proxy audité ; cross-tenant et DELETED ⇒ 404", async () => {
    const { db, state } = fakeDb(); const { storage, calls } = fakeStorage(); const deps = { db, storage, clock: () => NOW }
    const admin = await authorizeUploadTarget(session("u-admin", "ADMIN"), { worksiteId: "w2", truckId: "t1" }, deps)
    await uploadPhoto(admin, file, payload, KEY, deps)
    const emp = await authorizeUploadTarget(session("u-emp", "EMPLOYEE"), { worksiteId: "w1", truckId: "t1" }, deps)
    const mine = await uploadPhoto(emp, file, payload, "55555555-5555-4555-8555-555555555555", deps)
    const forEmployee = await listPhotos(session("u-emp", "EMPLOYEE"), { worksiteId: null, cursor: null, limit: null }, deps)
    assert.deepEqual(forEmployee.photos.map((p) => p.id), [mine.photoId], "la photo du chantier w2 n'est pas visible de l'employé")
    assert.equal(JSON.stringify(forEmployee).includes("drive-"), false, "aucun identifiant Drive dans la liste")
    const forAdmin = await listPhotos(session("u-admin", "ADMIN"), { worksiteId: null, cursor: null, limit: "1" }, deps)
    assert.equal(forAdmin.photos.length, 1)
    assert.ok(forAdmin.nextCursor)
    const opened = await openPhotoFile(session("u-emp", "EMPLOYEE"), mine.photoId, deps)
    assert.equal(opened.mimeType, "image/jpeg")
    assert.ok(calls.some((c) => c.startsWith("download:")))
    const otherPhoto = state.photos.find((p) => p.worksiteId === "w2")!
    await expectCode(openPhotoFile(session("u-emp", "EMPLOYEE"), otherPhoto.id, deps), "PHOTO_NOT_FOUND", 404)
    assert.equal(state.events.filter((e) => e.action === "ACCESS_DENIED").length, 1)
    assert.equal(state.events.filter((e) => e.action === "ACCESS_GRANTED").length, 1)
    otherPhoto.status = "DELETED"
    await expectCode(openPhotoFile(session("u-admin", "ADMIN"), otherPhoto.id, deps), "PHOTO_NOT_FOUND", 404)
  })
})
