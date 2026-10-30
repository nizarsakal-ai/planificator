/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 1 — preuves avec base PostgreSQL réelle et JETABLE.
 *
 * Exécute les sondes SQL de tests/worksite-photos/sql/lot1-probes.sql (dans une transaction annulée) contre une base
 * sur laquelle l'historique complet des migrations a été appliqué (`prisma migrate deploy`). Chaque sonde attend
 * un refus de la base (CHECK, déclencheur, FK composite, unicité NULLS NOT DISTINCT) ; un refus manquant fait échouer
 * le script, donc le test.
 *
 * Prérequis : WORKSITE_PHOTOS_TEST_DATABASE_URL = base jetable locale (ex. conteneur `postgres:17`), jamais DATABASE_URL.
 * Le test ÉCHOUE (il ne saute pas) si la variable est absente ou si l'URL ne vise pas une base locale.
 * Exemple : docker run -d --name wp-pg -e POSTGRES_PASSWORD=x -e POSTGRES_DB=t -p 127.0.0.1:55433:5432 postgres:17
 *           WORKSITE_PHOTOS_TEST_DATABASE_URL=postgresql://postgres:x@127.0.0.1:55433/t npx prisma migrate deploy
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, it } from "node:test"

const require = createRequire(import.meta.url)
const PROBES = path.join(process.cwd(), "tests/worksite-photos/sql/lot1-probes.sql")

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

describe("migration worksite_photos_lot1 — base jetable", () => {
  it("l'historique est appliqué et les 46 sondes sont refusées par la base (contrainte attendue vérifiée)", { timeout: 120_000 }, () => {
    const url = disposableUrl()
    const run = prismaDbExecute(url, PROBES)
    const output = `${run.stdout}\n${run.stderr}`
    assert.equal(run.status, 0, `sondes SQL en échec :\n${output.slice(-4000)}`)
    assert.doesNotMatch(output, /ATTENDU REFUS mais accepté/)
  })
  it("ROLLBACK.sql puis ré-application : le lot est réversible tant qu'aucune donnée n'existe", { timeout: 180_000 }, () => {
    const url = disposableUrl()
    const rollback = prismaDbExecute(url, path.join(process.cwd(), "prisma/migrations/20261030180000_worksite_photos_lot1/ROLLBACK.sql"))
    assert.equal(rollback.status, 0, `rollback en échec :\n${rollback.stderr.slice(-2000)}`)
    const cli = require.resolve("prisma/build/index.js")
    const deploy = spawnSync(process.execPath, [cli, "migrate", "deploy"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } })
    assert.equal(deploy.status, 0, `migrate deploy en échec :\n${deploy.stderr.slice(-2000)}`)
    assert.match(deploy.stdout, /20261030180000_worksite_photos_lot1/)
    const again = prismaDbExecute(url, PROBES)
    assert.equal(again.status, 0, `sondes SQL après ré-application en échec :\n${again.stderr.slice(-2000)}`)
  })
  // Dernier test du fichier : il laisse volontairement une réservation (non supprimable) dans la base jetable.
  it("ROLLBACK.sql est REFUSÉ dès qu'une table du lot contient une ligne ou qu'un clientContact est renseigné ; rien n'est détruit (L1-R2)", { timeout: 120_000 }, async () => {
    const url = disposableUrl()
    const { PrismaClient } = await import("@prisma/client")
    const prisma = new PrismaClient({ datasources: { db: { url } } })
    const ROLLBACK = path.join(process.cwd(), "prisma/migrations/20261030180000_worksite_photos_lot1/ROLLBACK.sql")
    const expectRefused = async (label: string) => {
      const run = prismaDbExecute(url, ROLLBACK)
      assert.notEqual(run.status, 0, `${label} : le rollback aurait dû être refusé`)
      assert.match(`${run.stdout}\n${run.stderr}`, /ROLLBACK REFUSÉ/, label)
      const [{ migrations }] = await prisma.$queryRawUnsafe<Array<{ migrations: number }>>(`SELECT count(*)::int AS migrations FROM "_prisma_migrations" WHERE "migration_name" = '20261030180000_worksite_photos_lot1'`)
      assert.equal(migrations, 1, `${label} : l'entrée de migration doit rester`)
      const [{ present }] = await prisma.$queryRawUnsafe<Array<{ present: boolean }>>(`SELECT to_regclass('"worksite_truck_photos"') IS NOT NULL AS present`)
      assert.equal(present, true, `${label} : les tables doivent rester`)
    }
    try {
      await prisma.$executeRawUnsafe(`INSERT INTO "companies" ("id","name","slug","updatedAt") VALUES ('c-rb','C-RB','c-rb',now())`)
      // 1. une ligne dans une table du lot (dossier : supprimable ensuite, aucun déclencheur)
      await prisma.$executeRawUnsafe(`INSERT INTO "worksite_photo_drive_folders" ("id","companyId","driveFolderId","path") VALUES ('f-rb','c-rb','folder-rb','/Chantiers')`)
      await expectRefused("dossier Drive présent")
      await prisma.$executeRawUnsafe(`DELETE FROM "worksite_photo_drive_folders" WHERE "id" = 'f-rb'`)
      // 2. un contact client renseigné sur un chantier
      await prisma.$executeRawUnsafe(`INSERT INTO "users" ("id","email","password","role","companyId","updatedAt") VALUES ('u-rb','u-rb@example.test','x','ADMIN','c-rb',now())`)
      await prisma.$executeRawUnsafe(`INSERT INTO "clients" ("id","name","companyId","updatedAt") VALUES ('cl-rb','Client RB','c-rb',now())`)
      await prisma.$executeRawUnsafe(`INSERT INTO "worksites" ("id","name","clientId","companyId","createdById","updatedAt","clientContact") VALUES ('w-rb','Chantier RB','cl-rb','c-rb','u-rb',now(),'contact@example.test')`)
      await expectRefused("clientContact renseigné")
      await prisma.$executeRawUnsafe(`UPDATE "worksites" SET "clientContact" = NULL WHERE "id" = 'w-rb'`)
      // 3. une réservation (jamais supprimable : le refus est définitif tant qu'elle existe)
      await prisma.$executeRawUnsafe(`INSERT INTO "trucks" ("id","matricule","companyId","updatedAt") VALUES ('t-rb','RB-000-RB','c-rb',now())`)
      await prisma.$executeRawUnsafe(`INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
        VALUES ('r-rb','c-rb','99999999-9999-4999-8999-999999999999',repeat('a',64),'w-rb','t-rb','u-rb','p-rb','drive-rb','22222222-2222-4222-8222-222222222222',now(),now())`)
      await expectRefused("réservation présente")
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "worksite_photo_upload_reservations" WHERE "id" = 'r-rb'`)
      assert.equal(n, 1, "la réservation est intacte")
    } finally {
      await prisma.$disconnect()
    }
  })
})
