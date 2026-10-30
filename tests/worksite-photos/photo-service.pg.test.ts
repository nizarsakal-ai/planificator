/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 3 — service d'upload contre PostgreSQL RÉEL et JETABLE, via l'adaptateur Prisma de production
 * (`prismaPhotoDb`) et un stockage factice : protocole service / adaptateur / déclencheurs et contraintes différées du Lot 1.
 *
 * Couvre les constats Codex L3-R1 (révocation entre admission et publication, sous les verrous de la transaction),
 * L3R2-R1 (équipe du chef désactivée ou chef remplacé : verrou FOR SHARE sur `teams` puis relecture),
 * L3-R2 (reprise avec `driveFileCreatedAt` déjà posé : publication, horodatage initial conservé) et la contrainte différée L1-R1
 * (photo + COMMITTED atomiques, refus d'un abandon sur réservation rattachée).
 *
 * Prérequis : WORKSITE_PHOTOS_TEST_DATABASE_URL = base jetable locale où `prisma migrate deploy` a été exécuté (voir migration.pg.test.ts).
 * Ce fichier s'exécute APRÈS migration.pg.test.ts (script `test:worksite-photos:pg`) : il laisse des données (photos non supprimables).
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { computeUploadRequestHash, WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import type { PhotoStoragePort, StoredFileInfo } from "@/lib/worksite-photos/photo-storage.port"
import { prismaPhotoDb } from "@/lib/worksite-photos/photo.prisma-adapter"
import { authorizeUploadTarget, uploadPhoto, type PhotoSession } from "@/lib/worksite-photos/photo.service"

function disposableUrl(): string {
  const url = process.env.WORKSITE_PHOTOS_TEST_DATABASE_URL?.trim()
  if (!url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL absente : base PostgreSQL jetable requise (voir en-tête du test).")
  const parsed = new URL(url)
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL doit viser une base locale jetable.")
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL ne doit pas être DATABASE_URL.")
  return url
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3])
const file = { filename: "IMG_0001.jpg", declaredMimeType: "image/jpeg", bytes: JPEG }
const payload = { phase: "BEFORE" as const }
const NOW = new Date("2026-10-30T10:00:00.000Z")
/** Identifiants propres à ce fichier (la base jetable peut contenir les restes de migration.pg.test.ts). */
const RUN = randomUUID().slice(0, 8)
const ids = {
  company: `c-svc-${RUN}`, admin: `u-adm-${RUN}`, worker: `u-wrk-${RUN}`, leader: `u-ldr-${RUN}`, employee: `e-wrk-${RUN}`, leaderEmployee: `e-ldr-${RUN}`,
  client: `cl-${RUN}`, worksite: `w-${RUN}`, truck: `t-${RUN}`, team: `tm-${RUN}`, assignment: `a-${RUN}`, employeeAssignment: `ea-${RUN}`,
}

function fakeStorage() {
  const files = new Map<string, StoredFileInfo>()
  const calls: string[] = []
  const storage: PhotoStoragePort = {
    provider: "drive",
    // Identifiants uniques entre scénarios : `driveFileId` est UNIQUE en base (comme les identifiants réels de `files.generateIds`).
    preallocateFileId: async () => `drive-${RUN}-${randomUUID().slice(0, 8)}`,
    resolveFolders: async (_c, input) => { calls.push("folders"); return { dayFolderId: "day", worksiteLabel: input.worksiteLabel, dayLabel: input.dayLabel } },
    createFile: async (_c, input) => {
      calls.push(`create:${input.id}`)
      if (files.has(input.id)) return { created: false, info: null }
      const info = { id: input.id, size: input.bytes.byteLength, md5: createHash("md5").update(input.bytes).digest("hex"), trashed: false }
      files.set(input.id, info); return { created: true, info }
    },
    getFile: async (_c, id) => { calls.push(`get:${id}`); return files.get(id) ?? null },
    download: async () => ({ stream: new ReadableStream(), contentType: "image/jpeg", contentLength: null }),
    trash: async (_c, id) => { calls.push(`trash:${id}`) },
    delete: async (_c, id) => { calls.push(`delete:${id}`) },
  }
  return { storage, calls, files }
}

const worker: PhotoSession = { user: { id: ids.worker, role: "EMPLOYEE", companyId: ids.company } }

describe("service d'upload × adaptateur Prisma × PostgreSQL jetable", () => {
  let prisma: PrismaClient
  before(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: disposableUrl() } } })
    const x = (sql: string) => prisma.$executeRawUnsafe(sql)
    await x(`INSERT INTO "companies" ("id","name","slug","updatedAt") VALUES ('${ids.company}','Svc ${RUN}','svc-${RUN}',now())`)
    await x(`INSERT INTO "users" ("id","email","password","role","companyId","updatedAt") VALUES
      ('${ids.admin}','adm-${RUN}@example.test','x','ADMIN','${ids.company}',now()),
      ('${ids.worker}','wrk-${RUN}@example.test','x','EMPLOYEE','${ids.company}',now()),
      ('${ids.leader}','ldr-${RUN}@example.test','x','TEAM_LEADER','${ids.company}',now())`)
    await x(`INSERT INTO "employees" ("id","userId","companyId","firstName","lastName","role","updatedAt") VALUES
      ('${ids.employee}','${ids.worker}','${ids.company}','Eva','Ouvrière','EMPLOYEE',now()),
      ('${ids.leaderEmployee}','${ids.leader}','${ids.company}','Léo','Chef','TEAM_LEADER',now())`)
    await x(`INSERT INTO "clients" ("id","name","companyId","updatedAt") VALUES ('${ids.client}','Lauralu','${ids.company}',now())`)
    await x(`INSERT INTO "worksites" ("id","name","clientId","companyId","createdById","status","updatedAt") VALUES ('${ids.worksite}','Chantier A','${ids.client}','${ids.company}','${ids.admin}','IN_PROGRESS',now())`)
    await x(`INSERT INTO "trucks" ("id","matricule","companyId","updatedAt") VALUES ('${ids.truck}','AA-${RUN.slice(0, 3).toUpperCase()}-AA','${ids.company}',now())`)
    await x(`INSERT INTO "teams" ("id","name","companyId","leaderId","updatedAt") VALUES ('${ids.team}','Équipe ${RUN}','${ids.company}','${ids.leaderEmployee}',now())`)
    await x(`INSERT INTO "assignments" ("id","worksiteId","teamId","date","updatedAt") VALUES ('${ids.assignment}','${ids.worksite}','${ids.team}','2026-10-30',now())`)
    await x(`INSERT INTO "employee_assignments" ("id","assignmentId","employeeId","date") VALUES ('${ids.employeeAssignment}','${ids.assignment}','${ids.employee}','2026-10-30')`)
  })
  after(async () => { await prisma.$disconnect() })

  const deps = () => { const { storage, calls, files } = fakeStorage(); return { deps: { db: prismaPhotoDb(prisma), storage, clock: () => NOW, env: {} as NodeJS.ProcessEnv }, calls, files } }
  const reservationByKey = (key: string) => prisma.worksitePhotoUploadReservation.findFirst({ where: { companyId: ids.company, idempotencyKey: key } })
  const photoCount = () => prisma.worksiteTruckPhoto.count({ where: { companyId: ids.company } })

  it("publication nominale : réservation COMMITTED, photo PENDING rattachée, contrainte différée satisfaite au COMMIT", async () => {
    const { deps: d } = deps()
    const key = randomUUID()
    const target = await authorizeUploadTarget(worker, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    const receipt = await uploadPhoto(target, file, payload, key, d)
    const reservation = await reservationByKey(key)
    assert.equal(reservation?.state, "COMMITTED")
    assert.ok(reservation?.driveFileCreatedAt)
    const photo = await prisma.worksiteTruckPhoto.findUnique({ where: { id: receipt.photoId } })
    assert.equal(photo?.status, "PENDING")
    assert.equal(photo?.reservationId, reservation?.id)
    assert.equal(photo?.driveFileId, reservation?.driveFileId)
    assert.equal(photo?.uploadedByNameSnapshot, "Eva Ouvrière")
    // Rejeu : même reçu, aucune nouvelle ligne.
    const again = await uploadPhoto(target, file, payload, key, d)
    assert.deepEqual([again.photoId, again.replayed], [receipt.photoId, true])
    // L1-R1 : une réservation rattachée ne peut plus être abandonnée (garde SQL).
    await assert.rejects(prisma.$executeRawUnsafe(`UPDATE "worksite_photo_upload_reservations" SET "state"='ABANDONED', "abandonedAt"=now() WHERE "id"='${reservation!.id}'`), /COMMITTED|terminal|rattachée/)
  })

  it("L3-R2 : reprise après interruption avec driveFileCreatedAt déjà posé et fichier existant ⇒ publication, horodatage initial conservé", async () => {
    const { deps: d, files } = deps()
    const key = randomUUID()
    const target = await authorizeUploadTarget(worker, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    const requestHash = computeUploadRequestHash({ companyId: ids.company, actorId: ids.worker, worksiteId: ids.worksite, truckId: ids.truck, phase: "BEFORE", sha256: createHash("sha256").update(JPEG).digest("hex"), sizeBytes: JPEG.byteLength })
    const createdAt = new Date("2026-10-30T09:50:00.000Z")
    const photoId = randomUUID().replace(/-/g, "").slice(0, 25)
    const driveFileId = `drive-${RUN}-old`
    // Tentative A : a créé le fichier, posé l'horodatage, puis a été interrompue avant le rattachement ; son bail est expiré.
    await prisma.$executeRawUnsafe(`INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
      VALUES ('res-${RUN}-old','${ids.company}','${key}','${requestHash}','${ids.worksite}','${ids.truck}','${ids.worker}','${photoId}','${driveFileId}','${randomUUID()}','2026-10-30T09:59:00.000Z',now())`)
    await prisma.$executeRawUnsafe(`UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING', "driveFileCreatedAt"='${createdAt.toISOString()}' WHERE "id"='res-${RUN}-old'`)
    files.set(driveFileId, { id: driveFileId, size: JPEG.byteLength, md5: createHash("md5").update(JPEG).digest("hex"), trashed: false })
    // Tentative B : reprise par la même clé.
    const receipt = await uploadPhoto(target, file, payload, key, d)
    assert.equal(receipt.photoId, photoId)
    const reservation = await reservationByKey(key)
    assert.equal(reservation?.state, "COMMITTED")
    assert.equal(reservation?.attemptGeneration, 2)
    assert.equal(reservation?.driveFileCreatedAt?.toISOString(), createdAt.toISOString(), "première valeur conservée (déclencheur SQL respecté)")
    assert.equal((await prisma.worksiteTruckPhoto.findUnique({ where: { id: photoId } }))?.driveFileId, driveFileId)
  })

  it("L3-R1 : affectation retirée entre admission et publication ⇒ 404, aucune photo, réservation ABANDONED", async () => {
    const { deps: d, calls } = deps()
    const key = randomUUID()
    const target = await authorizeUploadTarget(worker, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    const before = await photoCount()
    const original = d.storage.resolveFolders
    d.storage.resolveFolders = async (c, i) => {
      await prisma.$executeRawUnsafe(`DELETE FROM "employee_assignments" WHERE "id"='${ids.employeeAssignment}'`)
      return original(c, i)
    }
    try {
      await assert.rejects(uploadPhoto(target, file, payload, key, d), (e: unknown) => e instanceof WorksitePhotoDomainError && e.code === "WORKSITE_NOT_FOUND" && e.status === 404)
      assert.equal(await photoCount(), before, "aucune photo")
      const reservation = await reservationByKey(key)
      assert.equal(reservation?.state, "ABANDONED")
      assert.ok(reservation?.abandonedAt)
      assert.equal(calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false, "aucune suppression Drive (D18)")
    } finally {
      await prisma.$executeRawUnsafe(`INSERT INTO "employee_assignments" ("id","assignmentId","employeeId","date") VALUES ('${ids.employeeAssignment}','${ids.assignment}','${ids.employee}','2026-10-30')`)
    }
  })

  it("L3-R1 : compte désactivé entre admission et publication ⇒ 401, aucune photo, réservation ABANDONED", async () => {
    const { deps: d } = deps()
    const key = randomUUID()
    const target = await authorizeUploadTarget(worker, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    const before = await photoCount()
    const original = d.storage.resolveFolders
    d.storage.resolveFolders = async (c, i) => { await prisma.$executeRawUnsafe(`UPDATE "users" SET "active"=false WHERE "id"='${ids.worker}'`); return original(c, i) }
    try {
      await assert.rejects(uploadPhoto(target, file, payload, key, d), (e: unknown) => e instanceof WorksitePhotoDomainError && e.code === "UNAUTHENTICATED")
      assert.equal(await photoCount(), before)
      assert.equal((await reservationByKey(key))?.state, "ABANDONED")
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE "users" SET "active"=true WHERE "id"='${ids.worker}'`)
    }
  })

  it("L3-R1 : chef d'équipe dont l'équipe est retirée du chantier pendant la publication ⇒ 404 ; la révocation concurrente attend le verrou", async () => {
    const { deps: d } = deps()
    const key = randomUUID()
    const leader: PhotoSession = { user: { id: ids.leader, role: "TEAM_LEADER", companyId: ids.company } }
    const target = await authorizeUploadTarget(leader, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    const original = d.storage.resolveFolders
    d.storage.resolveFolders = async (c, i) => { await prisma.$executeRawUnsafe(`DELETE FROM "employee_assignments" WHERE "id"='${ids.employeeAssignment}'`); await prisma.$executeRawUnsafe(`DELETE FROM "assignments" WHERE "id"='${ids.assignment}'`); return original(c, i) }
    try {
      await assert.rejects(uploadPhoto(target, file, payload, key, d), (e: unknown) => e instanceof WorksitePhotoDomainError && e.code === "WORKSITE_NOT_FOUND")
      assert.equal((await reservationByKey(key))?.state, "ABANDONED")
    } finally {
      await prisma.$executeRawUnsafe(`INSERT INTO "assignments" ("id","worksiteId","teamId","date","updatedAt") VALUES ('${ids.assignment}','${ids.worksite}','${ids.team}','2026-10-30',now())`)
      await prisma.$executeRawUnsafe(`INSERT INTO "employee_assignments" ("id","assignmentId","employeeId","date") VALUES ('${ids.employeeAssignment}','${ids.assignment}','${ids.employee}','2026-10-30')`)
    }
  })

  it("course révocation / publication : le retrait d'affectation lancé pendant la transaction attend le verrou FOR SHARE et la photo est publiée", async () => {
    const { deps: d } = deps()
    const key = randomUUID()
    const target = await authorizeUploadTarget(worker, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    // On intercepte la transaction : juste après la relecture verrouillée, on lance la révocation SANS l'attendre ; elle doit bloquer jusqu'au COMMIT.
    const db = prismaPhotoDb(prisma)
    let revocation: Promise<number> | null = null
    let revocationSettledBeforeCommit = false
    d.db = {
      ...db,
      transaction: (fn) => db.transaction(async (tx) => {
        const wrapped = {
          ...tx,
          findWorksites: async (q: Parameters<typeof tx.findWorksites>[0]) => {
            const rows = await tx.findWorksites(q)
            const second = new PrismaClient({ datasources: { db: { url: disposableUrl() } } })
            revocation = second.$executeRawUnsafe(`DELETE FROM "employee_assignments" WHERE "id"='${ids.employeeAssignment}'`).finally(() => second.$disconnect())
            void revocation.then(() => { revocationSettledBeforeCommit = true })
            await new Promise((r) => setTimeout(r, 300))
            assert.equal(revocationSettledBeforeCommit, false, "la révocation attend le verrou")
            return rows
          },
        }
        return fn(wrapped)
      }),
    }
    const receipt = await uploadPhoto(target, file, payload, key, d)
    assert.equal((await reservationByKey(key))?.state, "COMMITTED")
    assert.equal((await prisma.worksiteTruckPhoto.findUnique({ where: { id: receipt.photoId } }))?.status, "PENDING")
    assert.equal(await revocation, 1, "la révocation s'applique APRÈS la publication")
    await prisma.$executeRawUnsafe(`INSERT INTO "employee_assignments" ("id","assignmentId","employeeId","date") VALUES ('${ids.employeeAssignment}','${ids.assignment}','${ids.employee}','2026-10-30')`)
  })

  // ── L3R2-R1 : l'équipe qui donne ses droits au chef (active, leaderId, société) est verrouillée puis relue dans la transaction ──
  const leader: PhotoSession = { user: { id: ids.leader, role: "TEAM_LEADER", companyId: ids.company } }
  const restoreTeam = () => prisma.$executeRawUnsafe(`UPDATE "teams" SET "active"=true, "leaderId"='${ids.leaderEmployee}' WHERE "id"='${ids.team}'`)

  /** Interpose `during` juste après la relecture verrouillée de l'autorité et de la visibilité, avant le CAS de publication. */
  function interceptAfterLockedRead(d: ReturnType<typeof deps>["deps"], during: () => Promise<void>) {
    const db = prismaPhotoDb(prisma)
    d.db = {
      ...db,
      transaction: (fn) => db.transaction(async (tx) => fn({
        ...tx,
        findWorksites: async (q: Parameters<typeof tx.findWorksites>[0]) => { const rows = await tx.findWorksites(q); await during(); return rows },
      })),
    }
  }

  for (const [label, revoke] of [
    ["équipe désactivée", `UPDATE "teams" SET "active"=false WHERE "id"='${ids.team}'`],
    ["chef remplacé sur l'équipe", `UPDATE "teams" SET "leaderId"='${ids.employee}' WHERE "id"='${ids.team}'`],
  ] as const) {
    it(`L3R2-R1 : ${label} entre admission et publication (avant la lecture verrouillée) ⇒ 404, aucune photo, réservation ABANDONED`, async () => {
      const { deps: d, calls } = deps()
      const key = randomUUID()
      const target = await authorizeUploadTarget(leader, { worksiteId: ids.worksite, truckId: ids.truck }, d)
      const before = await photoCount()
      const original = d.storage.resolveFolders
      d.storage.resolveFolders = async (c, i) => { await prisma.$executeRawUnsafe(revoke); return original(c, i) }
      try {
        await assert.rejects(uploadPhoto(target, file, payload, key, d), (e: unknown) => e instanceof WorksitePhotoDomainError && e.code === "WORKSITE_NOT_FOUND" && e.status === 404)
        assert.equal(await photoCount(), before, "aucune photo")
        assert.equal((await reservationByKey(key))?.state, "ABANDONED")
        assert.equal(calls.some((c) => c.startsWith("delete") || c.startsWith("trash")), false, "aucune suppression Drive (D18)")
      } finally {
        await restoreTeam()
      }
    })
  }

  it("L3R2-R1 course : désactivation de l'équipe lancée après la lecture verrouillée ⇒ elle attend le COMMIT ; la photo est publiée, l'équipe désactivée ensuite", async () => {
    const { deps: d } = deps()
    const key = randomUUID()
    const target = await authorizeUploadTarget(leader, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    let revocation: Promise<number> | null = null
    let settledInside = false
    interceptAfterLockedRead(d, async () => {
      const second = new PrismaClient({ datasources: { db: { url: disposableUrl() } } })
      revocation = second.$executeRawUnsafe(`UPDATE "teams" SET "active"=false WHERE "id"='${ids.team}'`).finally(() => second.$disconnect())
      void revocation.then(() => { settledInside = true }, () => undefined)
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(settledInside, false, "la désactivation attend le verrou FOR SHARE de l'équipe")
    })
    try {
      const receipt = await uploadPhoto(target, file, payload, key, d)
      assert.equal((await reservationByKey(key))?.state, "COMMITTED")
      assert.equal((await prisma.worksiteTruckPhoto.findUnique({ where: { id: receipt.photoId } }))?.status, "PENDING")
      assert.equal(await revocation, 1, "la désactivation s'applique APRÈS la publication")
      assert.equal((await prisma.team.findUnique({ where: { id: ids.team } }))?.active, false)
    } finally {
      await restoreTeam()
    }
  })

  it("L3R2-R1 course (protocole de la sonde Codex, lock_timeout 700 ms) : changement de chef pendant la transaction ⇒ bloqué par le verrou, refusé par lock_timeout, équipe inchangée, photo publiée", async () => {
    const { deps: d } = deps()
    const key = randomUUID()
    const target = await authorizeUploadTarget(leader, { worksiteId: ids.worksite, truckId: ids.truck }, d)
    let outcome: { code?: string; message: string } | null = null
    interceptAfterLockedRead(d, async () => {
      const second = new PrismaClient({ datasources: { db: { url: disposableUrl() } } })
      try {
        await second.$transaction(async (s) => {
          await s.$executeRawUnsafe("SET LOCAL lock_timeout = '700ms'")
          await s.$executeRawUnsafe(`UPDATE "teams" SET "leaderId"='${ids.employee}' WHERE "id"='${ids.team}'`)
        })
        outcome = { message: "UPDATE accepté sans attendre" }
      } catch (error) {
        const e = error as { code?: string; meta?: { code?: string }; message: string }
        outcome = { code: e.meta?.code ?? e.code, message: e.message }
      } finally {
        await second.$disconnect()
      }
    })
    try {
      const receipt = await uploadPhoto(target, file, payload, key, d)
      assert.ok(outcome, "la seconde connexion a été exercée")
      assert.match(outcome!.message, /lock timeout|55P03/i, `le changement de chef doit attendre le verrou : ${outcome!.message}`)
      assert.equal((await prisma.team.findUnique({ where: { id: ids.team } }))?.leaderId, ids.leaderEmployee, "équipe inchangée")
      assert.equal((await prisma.worksiteTruckPhoto.findUnique({ where: { id: receipt.photoId } }))?.status, "PENDING")
    } finally {
      await restoreTeam()
    }
  })
})
