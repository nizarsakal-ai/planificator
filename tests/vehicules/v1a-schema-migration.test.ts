// VEHICLES V1A — contrôles statiques du schéma Prisma et de la migration (aucune connexion DB).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const MIGRATION_NAME = "20261006120000_vehicles_v1a_foundation"
const schema = readFileSync("prisma/schema.prisma", "utf8")
const sql = readFileSync(`prisma/migrations/${MIGRATION_NAME}/migration.sql`, "utf8")

/** Bloc `model X { … }` / `enum X { … }` sans commentaires de fin de ligne. */
function block(kind: "model" | "enum", name: string): string {
  const m = schema.match(new RegExp(`^${kind} ${name} \\{([\\s\\S]*?)^\\}`, "m"))
  assert.ok(m, `${kind} ${name} introuvable`)
  return m[1]
    .split("\n")
    .map((l) => l.replace(/\s*\/\/.*$/, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n")
}

/** SQL exécutable : commentaires `--` retirés, espaces normalisés. */
const executable = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
const flat = executable.replace(/\s+/g, " ")

const field = (body: string, name: string) => body.split("\n").find((l) => l.trim().split(/\s+/)[0] === name)?.trim() ?? ""

describe("V1A — schéma Prisma", () => {
  const truck = block("model", "Truck")
  const ta = block("model", "TruckAssignment")
  const company = block("model", "Company")

  it("Truck.active Boolean @default(true) et archivedAt DateTime? (nullable)", () => {
    assert.match(field(truck, "active"), /^active\s+Boolean\s+@default\(true\)$/)
    assert.match(field(truck, "archivedAt"), /^archivedAt\s+DateTime\?$/)
  })

  it("TruckAssignment.reason nullable (enum) et openForTruckId nullable @unique", () => {
    assert.match(field(ta, "reason"), /^reason\s+TruckAssignmentReason\?$/)
    assert.match(field(ta, "openForTruckId"), /^openForTruckId\s+String\?\s+@unique$/)
  })

  it("enum TruckAssignmentReason exact", () => {
    assert.deepEqual(
      block("enum", "TruckAssignmentReason").split("\n").map((l) => l.trim()),
      ["CREATED", "REASSIGNED", "DISPLACED", "ARCHIVED", "RESTORED", "BACKFILL"]
    )
  })

  it("relations Company restrictives (jamais Cascade) sur Truck et TruckAssignment", () => {
    for (const body of [truck, ta]) {
      const rel = field(body, "company")
      assert.match(rel, /^company\s+Company\s+@relation\(fields: \[companyId\], references: \[id\], onDelete: Restrict\)$/)
    }
    assert.match(company, /^\s+trucks\s+Truck\[\]$/m)
    assert.match(company, /^\s+truckAssignments\s+TruckAssignment\[\]$/m)
  })

  it("relations existantes (Truck.team / chauffeur SetNull ; historique passé en Restrict par V1B-db)", () => {
    assert.match(field(truck, "team"), /onDelete: SetNull\)$/)
    assert.match(field(truck, "chauffeur"), /onDelete: SetNull\)$/)
    assert.match(field(ta, "truck"), /onDelete: Restrict\)$/)
    assert.match(field(ta, "chauffeur"), /onDelete: Restrict\)$/)
    assert.match(field(ta, "team"), /onDelete: Restrict\)$/)
  })

  it("identité V1 conservée ; l'unique tenant ajouté en V2 ne remplace pas l'unique matricule", () => {
    for (const name of ["brand", "model", "vehicleModel"]) assert.equal(field(truck, name), "", name)
    assert.match(field(truck, "marque"), /^marque\s+String\?$/)
    assert.match(truck, /@@unique\(\[matricule, companyId\]\)/)
  })
})

describe("V1A — migration SQL", () => {
  it("migration V1A présente ; les lots suivants peuvent ajouter des migrations", async () => {
    const { readdirSync } = await import("node:fs")
    // V1A était la plus récente du socle existant au moment de son ajout : sa devancière
    // reste fixe, quelles que soient les migrations ajoutées ensuite (V1B/V1C, Tâches, V2…).
    const names = readdirSync("prisma/migrations")
      .filter((n) => /^\d{14}_/.test(n) && n <= MIGRATION_NAME)
      .sort()
    assert.equal(names.at(-1), MIGRATION_NAME)
    assert.equal(names.at(-2), "20260913230000_acq_consultation_detection")
  })

  it("transaction explicite BEGIN … COMMIT et lock_timeout local", () => {
    const statements = executable.trim()
    assert.match(statements, /^BEGIN;/)
    assert.match(statements, /COMMIT;$/)
    assert.equal((flat.match(/\bBEGIN;/g) ?? []).length, 1)
    assert.equal((flat.match(/\bCOMMIT;/g) ?? []).length, 1)
    assert.match(flat, /BEGIN; SET LOCAL lock_timeout = '5s';/)
  })

  it("gardes orphelins trucks / truck_assignments et périodes ouvertes multiples, AVANT toute modification", () => {
    const guards = flat.indexOf("DO $$")
    const firstChange = Math.min(
      ...["CREATE TYPE", "ALTER TABLE", "CREATE FUNCTION", "CREATE TRIGGER", "UPDATE \"truck_assignments\"", "CREATE UNIQUE INDEX"].map((k) =>
        flat.indexOf(k)
      )
    )
    assert.ok(guards > 0 && guards < firstChange)
    const guardBlock = flat.slice(guards, flat.indexOf("END $$;"))
    assert.match(guardBlock, /FROM "trucks" t LEFT JOIN "companies" c ON c."id" = t."companyId" WHERE c."id" IS NULL/)
    assert.match(guardBlock, /FROM "truck_assignments" a LEFT JOIN "companies" c ON c."id" = a."companyId" WHERE c."id" IS NULL/)
    assert.match(guardBlock, /WHERE "endedAt" IS NULL GROUP BY "truckId" HAVING COUNT\(\*\) > 1/)
    assert.equal((guardBlock.match(/RAISE EXCEPTION/g) ?? []).length, 3)
    assert.doesNotMatch(guardBlock, /\b(UPDATE|DELETE|INSERT)\b/)
  })

  it("FK companyId restrictives sur les deux tables, jamais CASCADE à la suppression", () => {
    assert.match(
      flat,
      /ALTER TABLE "trucks" ADD CONSTRAINT "trucks_companyId_fkey" FOREIGN KEY \("companyId"\) REFERENCES "companies"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/
    )
    assert.match(
      flat,
      /ALTER TABLE "truck_assignments" ADD CONSTRAINT "truck_assignments_companyId_fkey" FOREIGN KEY \("companyId"\) REFERENCES "companies"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE;/
    )
    assert.doesNotMatch(flat, /ON DELETE CASCADE/)
    assert.doesNotMatch(flat, /ON DELETE SET NULL/)
  })

  it("enum reason, colonnes reason / openForTruckId nullables, active / archivedAt", () => {
    assert.match(
      flat,
      /CREATE TYPE "TruckAssignmentReason" AS ENUM \('CREATED', 'REASSIGNED', 'DISPLACED', 'ARCHIVED', 'RESTORED', 'BACKFILL'\);/
    )
    assert.match(flat, /ALTER TABLE "trucks" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "archivedAt" TIMESTAMP\(3\);/)
    assert.match(flat, /ALTER TABLE "truck_assignments" ADD COLUMN "openForTruckId" TEXT, ADD COLUMN "reason" "TruckAssignmentReason";/)
  })

  it("trigger + fonction nommés v1a, sans OR REPLACE, logique sentinelle exacte", () => {
    assert.match(flat, /CREATE FUNCTION "truck_assignments_v1a_sync_open_for_truck_id"\(\) RETURNS trigger LANGUAGE plpgsql/)
    assert.match(flat, /NEW."openForTruckId" := CASE WHEN NEW."endedAt" IS NULL THEN NEW."truckId" ELSE NULL END; RETURN NEW;/)
    assert.match(
      flat,
      /CREATE TRIGGER "truck_assignments_v1a_open_for_truck_id" BEFORE INSERT OR UPDATE ON "truck_assignments" FOR EACH ROW EXECUTE FUNCTION "truck_assignments_v1a_sync_open_for_truck_id"\(\);/
    )
    assert.doesNotMatch(flat, /OR REPLACE/)
    assert.ok(flat.indexOf("CREATE TRIGGER") < flat.indexOf('UPDATE "truck_assignments"'))
    assert.ok(flat.indexOf('UPDATE "truck_assignments"') < flat.indexOf("CREATE UNIQUE INDEX"))
  })

  it("unicité openForTruckId (nom Prisma) et CHECK d'archivage", () => {
    assert.match(flat, /CREATE UNIQUE INDEX "truck_assignments_openForTruckId_key" ON "truck_assignments"\("openForTruckId"\);/)
    assert.match(
      flat,
      /ALTER TABLE "trucks" ADD CONSTRAINT "trucks_v1a_archived_unassigned_check" CHECK \("active" OR \("teamId" IS NULL AND "chauffeurId" IS NULL\)\);/
    )
  })

  it("aucune suppression ni réécriture de données métier, aucun BACKFILL", () => {
    assert.doesNotMatch(flat, /\bDELETE\s+FROM\b/)
    assert.doesNotMatch(flat, /\bDROP\b/)
    assert.doesNotMatch(flat, /\bTRUNCATE\b/)
    assert.doesNotMatch(flat, /\bINSERT\s+INTO\b/)
    assert.doesNotMatch(flat, /'BACKFILL'\s*\)?\s*(FROM|,\s*CURRENT)/)
    const updates = flat.match(/UPDATE "[^"]+" SET [^;]+;/g) ?? []
    assert.deepEqual(updates, ['UPDATE "truck_assignments" SET "openForTruckId" = "truckId" WHERE "endedAt" IS NULL;'])
    assert.doesNotMatch(flat, /"marque"|"teamId" =|"chauffeurId" =|"reason" =/)
  })

  it("pas de CHECK chronologique en V1A (reporté en V1B-db)", () => {
    assert.doesNotMatch(flat, /"endedAt" >= "startedAt"/)
  })

  it("hors périmètre absent de la migration : brand/model, unique (id, companyId)", () => {
    assert.doesNotMatch(flat, /"brand"|"model"|"vehicleModel"/)
    assert.doesNotMatch(flat, /\("id", "companyId"\)/)
  })
})
