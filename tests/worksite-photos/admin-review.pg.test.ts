/**
 * LOT-ADMIN-REVIEW — preuves sur PostgreSQL RÉEL et JETABLE (données entièrement synthétiques) :
 * sondes SQL de la migration, puis service de contrôle via l'adaptateur Prisma de production (`prismaReviewDb`) et un
 * stockage factice : autorité SUPER_ADMIN et isolation d'entreprise, courses validation / suppression sous verrous réels,
 * reprise des deux phases après panne Drive, chemin SENT → DELETED avec preuve intacte, proxy refusé après corbeille,
 * pagination au-delà de 50 et filtre chantier, refus du ROLLBACK dès qu'une donnée de revue existe.
 *
 * Prérequis : WORKSITE_PHOTOS_TEST_DATABASE_URL = base jetable locale migrée (voir migration.pg.test.ts), jamais DATABASE_URL.
 * S'exécute en dernier dans `test:worksite-photos:pg` : il laisse des données (photos non supprimables).
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { DriveProviderError } from "@/lib/worksite-photos/drive/drive.errors"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import { prismaPhotoDb, prismaReviewDb } from "@/lib/worksite-photos/photo.prisma-adapter"
import { approvePhoto, listReviewPhotos, trashPhoto, type ReviewServiceDeps } from "@/lib/worksite-photos/photo-review.service"
import { openPhotoFile, type PhotoSession } from "@/lib/worksite-photos/photo.service"
import type { PhotoStoragePort } from "@/lib/worksite-photos/photo-storage.port"

const require = createRequire(import.meta.url)

function disposableUrl(): string {
  const url = process.env.WORKSITE_PHOTOS_TEST_DATABASE_URL?.trim()
  if (!url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL absente : base PostgreSQL jetable requise (voir en-tête du test).")
  const parsed = new URL(url)
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL doit viser une base locale jetable.")
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL ne doit pas être DATABASE_URL.")
  return url
}

function prismaDbExecute(url: string, file: string) {
  const cli = require.resolve("prisma/build/index.js")
  return spawnSync(process.execPath, [cli, "db", "execute", "--url", url, "--file", file], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } })
}

const RUN = randomUUID().slice(0, 8)
const ids = {
  a: `c-rva-${RUN}`, b: `c-rvb-${RUN}`, saA: `u-saa-${RUN}`, adminA: `u-ada-${RUN}`, saB: `u-sab-${RUN}`,
  clA: `cl-a-${RUN}`, clB: `cl-b-${RUN}`, w1: `w1-${RUN}`, w2: `w2-${RUN}`, wB: `wb-${RUN}`, tA: `ta-${RUN}`, tB: `tb-${RUN}`,
}
const saA: PhotoSession = { user: { id: ids.saA, role: "SUPER_ADMIN", companyId: ids.a } }
const saB: PhotoSession = { user: { id: ids.saB, role: "SUPER_ADMIN", companyId: ids.b } }

function fakeStorage(mode: { fail?: boolean; missing?: boolean } = {}) {
  const calls: string[] = []
  const storage = {
    trash: async (_c: string, id: string) => {
      calls.push(id)
      if (mode.fail) throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true)
      return { missing: !!mode.missing }
    },
    download: async () => ({ stream: new ReadableStream(), contentType: "image/jpeg", contentLength: null }),
  } as unknown as PhotoStoragePort
  return { storage, calls }
}

const codeOf = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e instanceof WorksitePhotoDomainError ? `${e.status}:${e.code}` : (e as Error).message } }

describe("contrôle Super Admin × adaptateur Prisma × PostgreSQL jetable", () => {
  let prisma: PrismaClient
  let deps: (storage?: PhotoStoragePort) => ReviewServiceDeps
  let n = 0

  /** Publie une photo PENDING synthétique (réservation COMMITTED + photo, dans une transaction : contrainte différée). */
  async function publish(company: string, worksite: string, truck: string, uploader: string): Promise<string> {
    const id = `p-${RUN}-${String(++n).padStart(3, "0")}`
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
        VALUES ('r-${id}','${company}',gen_random_uuid(),repeat('a',64),'${worksite}','${truck}','${uploader}','${id}','drive-${id}',gen_random_uuid(),now()+interval '15 minutes',now())`),
      prisma.$executeRawUnsafe(`UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"='r-${id}'`),
      prisma.$executeRawUnsafe(`INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
        VALUES ('${id}','${company}','${worksite}','${truck}','r-${id}','BEFORE','drive-${id}','/Chantiers/x/2026-10-31/f.jpg','f.jpg','image/jpeg',10,repeat('c',64),'${uploader}','Ouvrier test')`),
      prisma.$executeRawUnsafe(`UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r-${id}'`),
    ])
    return id
  }
  const markSent = (id: string) => prisma.$executeRawUnsafe(`UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"='2026-10-30T10:00:00Z', "sentTo"='client@example.test', "sentMessageId"='<m-${id}@example.test>', "sentTransportKind"='smtp', "sentByAgent"='agent-test' WHERE "id"='${id}'`)
  const row = (id: string) => prisma.worksiteTruckPhoto.findUniqueOrThrow({ where: { id } })
  const actions = async (id: string) => (await prisma.worksitePhotoEvent.findMany({ where: { photoId: id }, orderBy: { createdAt: "asc" }, select: { action: true } })).map((e) => e.action)

  before(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: disposableUrl() } } })
    deps = (storage = fakeStorage().storage) => ({ reviewDb: prismaReviewDb(prisma), storage })
    const x = (sql: string) => prisma.$executeRawUnsafe(sql)
    await x(`INSERT INTO "companies" ("id","name","slug","updatedAt") VALUES ('${ids.a}','RV A ${RUN}','rva-${RUN}',now()),('${ids.b}','RV B ${RUN}','rvb-${RUN}',now())`)
    await x(`INSERT INTO "users" ("id","email","name","password","role","companyId","updatedAt") VALUES
      ('${ids.saA}','saa-${RUN}@example.test','Super Admin A','x','SUPER_ADMIN','${ids.a}',now()),
      ('${ids.adminA}','ada-${RUN}@example.test','Admin A','x','ADMIN','${ids.a}',now()),
      ('${ids.saB}','sab-${RUN}@example.test','Super Admin B','x','SUPER_ADMIN','${ids.b}',now())`)
    await x(`INSERT INTO "clients" ("id","name","companyId","updatedAt") VALUES ('${ids.clA}','Client A','${ids.a}',now()),('${ids.clB}','Client B','${ids.b}',now())`)
    await x(`INSERT INTO "worksites" ("id","name","clientId","companyId","createdById","status","updatedAt") VALUES
      ('${ids.w1}','Chantier 1','${ids.clA}','${ids.a}','${ids.saA}','IN_PROGRESS',now()),
      ('${ids.w2}','Chantier 2','${ids.clA}','${ids.a}','${ids.saA}','IN_PROGRESS',now()),
      ('${ids.wB}','Chantier B','${ids.clB}','${ids.b}','${ids.saB}','IN_PROGRESS',now())`)
    await x(`INSERT INTO "trucks" ("id","matricule","companyId","updatedAt") VALUES ('${ids.tA}','AA-000-AA','${ids.a}',now()),('${ids.tB}','BB-000-BB','${ids.b}',now())`)
  })
  after(async () => { await prisma?.$disconnect() })

  it("sondes SQL de la migration : toutes refusées avec la contrainte attendue (transaction annulée)", { timeout: 120_000 }, () => {
    const run = prismaDbExecute(disposableUrl(), path.join(process.cwd(), "tests/worksite-photos/sql/admin-review-probes.sql"))
    const output = `${run.stdout}\n${run.stderr}`
    assert.equal(run.status, 0, `sondes en échec :\n${output.slice(-3000)}`)
    assert.doesNotMatch(output, /ATTENDU REFUS mais accepté|ATTENDU VRAI|REFUS INATTENDU/)
  })

  it("autorité : ADMIN refusé, session SUPER_ADMIN d'un compte ADMIN refusée, autre entreprise ⇒ 404 audité, rien d'écrit", async () => {
    const id = await publish(ids.a, ids.w1, ids.tA, ids.adminA)
    assert.equal(await codeOf(approvePhoto({ user: { id: ids.adminA, role: "ADMIN", companyId: ids.a } }, id, deps())), "403:FORBIDDEN")
    assert.equal(await codeOf(approvePhoto({ user: { id: ids.adminA, role: "SUPER_ADMIN", companyId: ids.a } }, id, deps())), "403:FORBIDDEN")
    const st = fakeStorage()
    assert.equal(await codeOf(trashPhoto(saB, id, deps(st.storage))), "404:PHOTO_NOT_FOUND")
    assert.equal(await codeOf(approvePhoto(saB, id, deps())), "404:PHOTO_NOT_FOUND")
    assert.deepEqual(st.calls, [])
    const photo = await row(id)
    assert.equal(photo.approvedAt, null)
    assert.equal(photo.rejectRequestedAt, null)
    const denied = await prisma.worksitePhotoEvent.count({ where: { companyId: ids.b, action: "ACCESS_DENIED", actorId: ids.saB } })
    assert.equal(denied, 2)
    assert.deepEqual(await actions(id), [])
  })

  it("validation : horodatée par la base, attribuée, statut PENDING, rejeu sans second événement", async () => {
    const id = await publish(ids.a, ids.w1, ids.tA, ids.adminA)
    const before = new Date()
    const first = await approvePhoto(saA, id, deps())
    assert.equal(first.photo.approval.state, "APPROVED")
    assert.equal(first.photo.approval.byName, "Super Admin A")
    const stored = await row(id)
    assert.equal(stored.status, "PENDING")
    assert.equal(stored.approvedById, ids.saA)
    assert.ok(stored.approvedAt && stored.approvedAt.getTime() >= before.getTime() - 5_000)
    assert.equal((await approvePhoto(saA, id, deps())).replayed, true)
    assert.deepEqual(await actions(id), ["APPROVED"])
  })

  it("courses réelles : deux suppressions concurrentes ⇒ une intention, une finalisation, un événement de chaque", async () => {
    const id = await publish(ids.a, ids.w1, ids.tA, ids.adminA)
    const st = fakeStorage()
    const [a, b] = await Promise.all([trashPhoto(saA, id, deps(st.storage)), trashPhoto(saA, id, deps(st.storage))])
    assert.equal(a.photo.status, "REJECTED")
    assert.equal(b.photo.status, "REJECTED")
    assert.deepEqual(await actions(id), ["REJECT_REQUESTED", "REJECTED"])
    const stored = await row(id)
    assert.equal(stored.status, "REJECTED")
    assert.equal(stored.rejectRequestedById, ids.saA)
    assert.ok(stored.rejectedAt! >= stored.rejectRequestedAt!)
  })

  it("courses réelles : validation et suppression concurrentes ⇒ jamais validée après l'intention, état final REJECTED cohérent", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await publish(ids.a, ids.w2, ids.tA, ids.adminA)
      const settled = await Promise.allSettled([approvePhoto(saA, id, deps()), trashPhoto(saA, id, deps())])
      const stored = await row(id)
      assert.equal(stored.status, "REJECTED")
      const events = await actions(id)
      if (stored.approvedAt) {
        assert.ok(stored.approvedAt < stored.rejectRequestedAt!, "validation antérieure à l'intention")
        assert.deepEqual(events, ["APPROVED", "REJECT_REQUESTED", "REJECTED"])
      } else {
        assert.equal(settled[0].status, "rejected")
        assert.deepEqual(events, ["REJECT_REQUESTED", "REJECTED"])
      }
    }
  })

  it("panne Drive : intention durable, validation et envoi bloqués en base ; la reprise finalise sans dupliquer l'audit", async () => {
    const id = await publish(ids.a, ids.w1, ids.tA, ids.adminA)
    assert.equal(await codeOf(trashPhoto(saA, id, deps(fakeStorage({ fail: true }).storage))), "DRIVE_UNAVAILABLE")
    const stuck = await row(id)
    assert.equal(stuck.status, "PENDING")
    assert.ok(stuck.rejectRequestedAt)
    assert.equal(await codeOf(approvePhoto(saA, id, deps())), "409:PHOTO_DELETION_IN_PROGRESS")
    await assert.rejects(markSent(id), /23514[\s\S]*une photo en cours de rejet ne peut pas être marquée envoyée/)
    const page = await listReviewPhotos(saA, { worksiteId: null, filter: "TO_RESUME", cursor: null, limit: "100" }, deps())
    assert.ok(page.photos.some((p) => p.id === id && p.deletion.state === "TO_RESUME"))
    const resumed = await trashPhoto(saA, id, deps())
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.photo.status, "REJECTED")
    assert.deepEqual(await actions(id), ["REJECT_REQUESTED", "REJECTED"])
  })

  it("photo envoyée : validation refusée (aucune approbation inventée), suppression par SENT → DELETED avec preuve intacte et reprise", async () => {
    const id = await publish(ids.a, ids.w1, ids.tA, ids.adminA)
    await markSent(id)
    const sent = await row(id)
    assert.equal(await codeOf(approvePhoto(saA, id, deps())), "409:PHOTO_NOT_PENDING")
    assert.equal((await row(id)).approvedAt, null)
    assert.equal(await codeOf(trashPhoto(saA, id, deps(fakeStorage({ fail: true }).storage))), "DRIVE_UNAVAILABLE")
    const pending = await row(id)
    assert.equal(pending.status, "SENT")
    assert.ok(pending.trashRequestedAt)
    assert.equal(pending.trashRequestedById, ids.saA)
    const done = await trashPhoto(saA, id, deps())
    assert.equal(done.photo.status, "DELETED")
    assert.equal(done.photo.delivery.state, "SENT")
    const stored = await row(id)
    for (const field of ["sentAt", "sentTo", "sentMessageId", "sentTransportKind", "sentTransportRef", "sentByAgent"] as const) {
      assert.deepEqual(stored[field], sent[field], `preuve ${field} intacte`)
    }
    assert.equal(stored.rejectRequestedAt, null, "jamais requalifiée REJECTED")
    assert.deepEqual(await actions(id), ["TRASH_REQUESTED", "TRASHED"])
  })

  it("fichier absent côté Drive : finalisé, FILE_MISSING une fois ; le proxy refuse ensuite la photo (404 audité)", async () => {
    const id = await publish(ids.a, ids.w1, ids.tA, ids.adminA)
    await trashPhoto(saA, id, deps(fakeStorage({ missing: true }).storage))
    assert.deepEqual(await actions(id), ["REJECT_REQUESTED", "FILE_MISSING", "REJECTED"])
    const proxyDeps = { db: prismaPhotoDb(prisma), storage: fakeStorage().storage }
    assert.equal(await codeOf(openPhotoFile(saA, id, proxyDeps)), "404:PHOTO_NOT_FOUND")
    assert.deepEqual((await actions(id)).slice(-1), ["ACCESS_DENIED"])
  })

  it("galerie : plus de 50 photos ⇒ pages de 24 sans doublon ni trou, ordre décroissant ; filtre chantier ; isolation", async () => {
    for (let i = 0; i < 58; i++) await publish(ids.a, i % 2 === 0 ? ids.w1 : ids.w2, ids.tA, ids.adminA)
    await publish(ids.b, ids.wB, ids.tB, ids.saB)
    const total = await prisma.worksiteTruckPhoto.count({ where: { companyId: ids.a } })
    const seen: string[] = []
    const stamps: number[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Awaited<ReturnType<typeof listReviewPhotos>> = await listReviewPhotos(saA, { worksiteId: null, filter: "ALL", cursor, limit: null }, deps())
      pages++
      assert.ok(page.photos.length <= 24)
      seen.push(...page.photos.map((p) => p.id))
      stamps.push(...page.photos.map((p) => Date.parse(p.uploadedAt)))
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(seen.length, total)
    assert.equal(new Set(seen).size, total)
    assert.ok(pages >= 3)
    assert.ok(stamps.every((t, i) => i === 0 || stamps[i - 1] >= t), "ordre décroissant")
    assert.ok(seen.every((id) => !id.includes("rvb")) && !(await prisma.worksiteTruckPhoto.findMany({ where: { companyId: ids.b }, select: { id: true } })).some((p) => seen.includes(p.id)), "aucune photo d'une autre entreprise")
    const w2 = await listReviewPhotos(saA, { worksiteId: ids.w2, filter: "ALL", cursor: null, limit: "100" }, deps())
    assert.ok(w2.photos.length >= 29)
    assert.ok(w2.photos.every((p) => p.worksite.id === ids.w2))
    const foreign = await listReviewPhotos(saA, { worksiteId: ids.wB, filter: "ALL", cursor: null, limit: "100" }, deps())
    assert.equal(foreign.photos.length, 0, "chantier d'une autre entreprise : liste vide")
  })

  it("ROLLBACK admin_review refusé dès qu'une donnée de revue existe ; rien n'est retiré", { timeout: 120_000 }, async () => {
    const run = prismaDbExecute(disposableUrl(), path.join(process.cwd(), "prisma/migrations/20261031090000_worksite_photos_admin_review/ROLLBACK.sql"))
    assert.notEqual(run.status, 0)
    assert.match(`${run.stdout}\n${run.stderr}`, /ROLLBACK REFUSÉ/)
    const [{ present }] = await prisma.$queryRawUnsafe<Array<{ present: number }>>(`SELECT count(*)::int AS present FROM information_schema.columns WHERE table_name = 'worksite_truck_photos' AND column_name = 'approvedAt'`)
    assert.equal(present, 1)
  })
})
