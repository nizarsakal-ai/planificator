/**
 * V3 Lot 1 — rejeu de l'historique complet des migrations puis exercice des contraintes SQL
 * du lot Documents sur un moteur PostgreSQL embarqué (PGlite, hors dépôt).
 *
 * Ce test vérifie la syntaxe, les CHECK, les FK composites et les triggers d'immuabilité.
 * Il ne prouve NI les verrous NI la concurrence (connexion unique) : ces preuves relèvent
 * des tests PostgreSQL réels exécutés hors de cette copie.
 *
 * Prérequis : V3_PGLITE_DIR = dossier contenant node_modules/@electric-sql/pglite.
 * Le test échoue (il ne saute pas) si le moteur est absent.
 */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

type PGliteLike = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>; close(): Promise<void> }

async function loadPglite(): Promise<PGliteLike> {
  const dir = process.env.V3_PGLITE_DIR
  if (!dir) throw new Error("Set V3_PGLITE_DIR to a directory containing node_modules/@electric-sql/pglite")
  const require = createRequire(join(dir, "package.json"))
  const { PGlite } = require("@electric-sql/pglite") as { PGlite: { create(): Promise<PGliteLike> } }
  return PGlite.create()
}

async function expectSqlState(promise: Promise<unknown>, sqlstate: string, label: string) {
  await assert.rejects(promise, (error: unknown) => {
    const message = String((error as Error).message)
    const code = (error as { code?: string }).code
    return code === sqlstate || message.includes(sqlstate) || (sqlstate === "23514" && /violates check constraint|VEHICLES_V3/.test(message)) || (sqlstate === "23503" && /foreign key/.test(message)) || (sqlstate === "23505" && /unique/.test(message))
  }, label)
}

test("V3 PGlite : historique complet rejoué, contraintes et triggers du lot Documents", { timeout: 120_000 }, async () => {
  const db = await loadPglite()
  try {
    const names = readdirSync("prisma/migrations").filter((name) => name !== "migration_lock.toml").sort()
    for (const name of names) await db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"))
    assert.ok(names.includes("20261025120000_vehicles_v3_documents"))

    const triggers = await db.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN ('vehicle_audit_logs'::regclass, 'vehicle_document_reminders'::regclass,
        'vehicle_document_versions'::regclass, 'vehicle_documents'::regclass)
      ORDER BY tgname`)
    assert.deepEqual(triggers.rows.map((row) => row.tgname), ["vehicle_audit_logs_v3_append_only", "vehicle_document_reminders_v3_append_only", "vehicle_document_versions_v3_guard", "vehicle_documents_v3_guard"])

    await db.exec(`
      INSERT INTO "companies" ("id", "name", "slug", "updatedAt") VALUES ('c1', 'C1', 'c1', now()), ('c2', 'C2', 'c2', now());
      INSERT INTO "users" ("id", "email", "password", "role", "companyId", "updatedAt") VALUES ('u1', 'u1@example.test', 'x', 'ADMIN', 'c1', now());
      INSERT INTO "trucks" ("id", "matricule", "companyId", "updatedAt") VALUES ('t1', 'AA-111-AA', 'c1', now()), ('t2', 'BB-222-BB', 'c2', now());
      INSERT INTO "vehicle_documents" ("id", "companyId", "truckId", "category", "title", "createdById", "createdByNameSnapshot", "updatedAt")
        VALUES ('d1', 'c1', 't1', 'INSURANCE', 'Attestation', 'u1', 'Admin', now());
    `)
    const insertVersion = (id: string, extra: { columns: string; values: string } | null = null) => db.exec(`
      INSERT INTO "vehicle_document_versions" ("id", "companyId", "truckId", "documentId", "versionNumber", "storageProvider", "storageKey", "storageResourceType", "storageDeliveryType",
        "originalFilename", "mimeType", "sizeBytes", "sha256", "uploadedById", "uploadedByNameSnapshot", "idempotencyKey", "requestHash"${extra ? ", " + extra.columns : ""})
      VALUES ('${id}', 'c1', 't1', 'd1', ${id === "v1" ? 1 : 2}, 'cloudinary', 'k/${id}', 'raw', 'authenticated', 'a.pdf', 'application/pdf', 10, repeat('a', 64), 'u1', 'Admin',
        '${id === "v1" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"}', repeat('b', 64)${extra ? ", " + extra.values : ""})`)

    await insertVersion("v1")
    await db.exec(`UPDATE "vehicle_documents" SET "currentVersionId" = 'v1' WHERE "id" = 'd1'`)

    // Tenant : une version d'un autre tenant / autre camion est refusée par la FK composite.
    await expectSqlState(db.exec(`INSERT INTO "vehicle_document_versions" ("id", "companyId", "truckId", "documentId", "versionNumber", "storageProvider", "storageKey", "storageResourceType", "storageDeliveryType", "originalFilename", "mimeType", "sizeBytes", "sha256", "uploadedById", "uploadedByNameSnapshot", "idempotencyKey", "requestHash")
      VALUES ('vx', 'c2', 't2', 'd1', 3, 'cloudinary', 'k/vx', 'raw', 'authenticated', 'a.pdf', 'application/pdf', 10, repeat('a', 64), 'u1', 'Admin', '33333333-3333-4333-8333-333333333333', repeat('b', 64))`), "23503", "FK composite tenant")
    // CHECK : stockage non authentifié, empreinte invalide, dates incohérentes, carte grise avec kilométrage négatif.
    await expectSqlState(db.exec(`UPDATE "vehicle_document_versions" SET "storageDeliveryType" = 'upload' WHERE "id" = 'v1'`), "23514", "livraison publique refusée")
    await expectSqlState(insertVersion("v2", { columns: `"validFrom", "validUntil"`, values: `'2027-01-01', '2026-01-01'` }), "23514", "dates incohérentes")
    // Immuabilité : contenu figé, validation puis remplacement seulement, suppression interdite.
    await expectSqlState(db.exec(`UPDATE "vehicle_document_versions" SET "sha256" = repeat('c', 64) WHERE "id" = 'v1'`), "23514", "empreinte immuable")
    await expectSqlState(db.exec(`UPDATE "vehicle_document_versions" SET "mileage" = 5 WHERE "id" = 'v1'`), "23514", "kilométrage immuable")
    await db.exec(`UPDATE "vehicle_document_versions" SET "verifiedAt" = now(), "verifiedById" = 'u1', "verifiedByNameSnapshot" = 'Admin' WHERE "id" = 'v1'`)
    await expectSqlState(db.exec(`UPDATE "vehicle_document_versions" SET "verifiedById" = 'u2' WHERE "id" = 'v1'`), "23514", "validation immuable")
    await expectSqlState(db.exec(`DELETE FROM "vehicle_document_versions" WHERE "id" = 'v1'`), "23514", "suppression version interdite")
    await expectSqlState(db.exec(`DELETE FROM "vehicle_documents" WHERE "id" = 'd1'`), "23514", "suppression dossier interdite")
    await expectSqlState(db.exec(`UPDATE "vehicle_documents" SET "category" = 'REGISTRATION' WHERE "id" = 'd1'`), "23514", "rubrique figée")
    await expectSqlState(db.exec(`UPDATE "vehicle_documents" SET "revision" = 0 WHERE "id" = 'd1'`), "23514", "révision décroissante")
    // Remplacement : v2 puis supersededAt sur v1 ; numéro de version unique.
    await insertVersion("v2")
    await expectSqlState(insertVersion("v2"), "23505", "numéro de version unique")
    await db.exec(`UPDATE "vehicle_documents" SET "currentVersionId" = 'v2', "revision" = 2 WHERE "id" = 'd1'`)
    await db.exec(`UPDATE "vehicle_document_versions" SET "supersededAt" = now() WHERE "id" = 'v1'`)
    await expectSqlState(db.exec(`UPDATE "vehicle_document_versions" SET "supersededAt" = NULL WHERE "id" = 'v1'`), "23514", "remplacement irréversible")
    // Rappels : reçu unique, ajout seul ; seuils bornés.
    await db.exec(`INSERT INTO "vehicle_document_reminders" ("id", "companyId", "truckId", "documentId", "versionId", "thresholdDays", "dueOn", "recipientUserId") VALUES ('r1', 'c1', 't1', 'd1', 'v2', 30, '2026-11-15', 'u1')`)
    await expectSqlState(db.exec(`INSERT INTO "vehicle_document_reminders" ("id", "companyId", "truckId", "documentId", "versionId", "thresholdDays", "dueOn", "recipientUserId") VALUES ('r2', 'c1', 't1', 'd1', 'v2', 30, '2026-11-15', 'u1')`), "23505", "reçu dédupliqué")
    await expectSqlState(db.exec(`UPDATE "vehicle_document_reminders" SET "thresholdDays" = 7 WHERE "id" = 'r1'`), "23514", "reçu en ajout seul")
    await expectSqlState(db.exec(`INSERT INTO "vehicle_document_reminder_settings" ("id", "companyId", "thresholdsDays", "updatedAt", "updatedById", "updatedByNameSnapshot") VALUES ('s1', 'c1', ARRAY[]::integer[], now(), 'u1', 'Admin')`), "23514", "seuils vides refusés")
    await db.exec(`INSERT INTO "vehicle_document_reminder_settings" ("id", "companyId", "thresholdsDays", "updatedAt", "updatedById", "updatedByNameSnapshot") VALUES ('s1', 'c1', ARRAY[30, 7], now(), 'u1', 'Admin')`)
    // Audit : ajout seul, résultat contrôlé.
    await db.exec(`INSERT INTO "vehicle_audit_logs" ("id", "companyId", "truckId", "actorId", "actorNameSnapshot", "action", "entityType", "outcome") VALUES ('a1', 'c1', 't1', 'u1', 'Admin', 'DOCUMENT_VIEW', 'VehicleDocumentVersion', 'GRANTED')`)
    await expectSqlState(db.exec(`INSERT INTO "vehicle_audit_logs" ("id", "companyId", "truckId", "actorId", "actorNameSnapshot", "action", "entityType", "outcome") VALUES ('a2', 'c1', 't1', 'u1', 'Admin', 'DOCUMENT_VIEW', 'VehicleDocumentVersion', 'MAYBE')`), "23514", "résultat d'audit contrôlé")
    await expectSqlState(db.exec(`DELETE FROM "vehicle_audit_logs" WHERE "id" = 'a1'`), "23514", "audit en ajout seul")
    // Notifications : nouvelles valeurs d'énumération utilisables.
    await db.exec(`INSERT INTO "notifications" ("id", "userId", "companyId", "type", "title", "message") VALUES ('n1', 'u1', 'c1', 'VEHICLE_DOCUMENT_EXPIRING', 'x', 'y')`)
    const counts = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "vehicle_document_versions"`)
    assert.equal(counts.rows[0].n, 2)
  } finally { await db.close() }
})
