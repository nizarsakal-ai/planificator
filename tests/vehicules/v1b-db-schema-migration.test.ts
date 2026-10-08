// VEHICLES V1B-db — contrôles statiques du schéma Prisma et de la migration (aucune connexion DB).
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const MIGRATION_NAME = "20261006180000_vehicles_v1b_db_integrity"
const schema = readFileSync("prisma/schema.prisma", "utf8")
const sql = readFileSync(`prisma/migrations/${MIGRATION_NAME}/migration.sql`, "utf8")

const executable = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
const flat = executable.replace(/\s+/g, " ")

const taModel = schema.match(/^model TruckAssignment \{([\s\S]*?)^\}/m)?.[1] ?? ""
const relation = (name: string) => taModel.split("\n").find((l) => l.trim().startsWith(`${name} `) && l.includes("@relation")) ?? ""
const idx = (needle: string) => {
  const i = flat.indexOf(needle)
  assert.ok(i >= 0, `introuvable : ${needle}`)
  return i
}

describe("V1B-db — schéma Prisma", () => {
  it("truck / chauffeur / team / company : onDelete Restrict", () => {
    for (const r of ["truck", "chauffeur", "team", "company"]) {
      assert.match(relation(r), /onDelete: Restrict/, `TruckAssignment.${r}`)
    }
  })

  it("chauffeurId et teamId restent nullables, reason nullable côté Prisma", () => {
    assert.match(taModel, /^\s*chauffeurId\s+String\?/m)
    assert.match(taModel, /^\s*teamId\s+String\?/m)
    assert.match(taModel, /^\s*reason\s+TruckAssignmentReason\?/m)
  })

  it("Truck.chauffeur / Truck.team restent SET NULL (état courant)", () => {
    const truck = schema.match(/^model Truck \{([\s\S]*?)^\}/m)?.[1] ?? ""
    assert.match(truck.split("\n").find((l) => l.includes("chauffeur ") && l.includes("@relation")) ?? "", /onDelete: SetNull/)
    assert.match(truck.split("\n").find((l) => /^\s*team\s/.test(l) && l.includes("@relation")) ?? "", /onDelete: SetNull/)
  })

  it("migration V1B-db présente et postérieure à V1A", () => {
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort()
    assert.ok(names.includes(MIGRATION_NAME))
    assert.ok(names.indexOf(MIGRATION_NAME) > names.indexOf("20261006120000_vehicles_v1a_foundation"))
  })
})

describe("V1B-db — migration atomique", () => {
  it("BEGIN … COMMIT, lock_timeout, un seul COMMIT", () => {
    assert.match(flat, /^ ?BEGIN; SET LOCAL lock_timeout = '5s';/)
    assert.match(flat, /COMMIT; ?$/)
    assert.equal((flat.match(/\bCOMMIT;/g) ?? []).length, 1)
    assert.equal((flat.match(/\bBEGIN;/g) ?? []).length, 1)
  })

  it("verrous déterministes avant toute opération", () => {
    const lock = idx('LOCK TABLE "truck_assignments" IN ACCESS EXCLUSIVE MODE; LOCK TABLE "employees", "teams", "trucks" IN SHARE ROW EXCLUSIVE MODE;')
    assert.ok(lock < idx("DO $$"))
  })

  it("gardes (chronologie, orphelins, enum, FK, trigger, collisions) avant le BACKFILL et le DDL", () => {
    const backfill = idx('UPDATE "truck_assignments"')
    const alter = idx('ALTER TABLE "truck_assignments" DROP CONSTRAINT')
    const guards = flat.slice(0, backfill)
    for (const needle of [
      '"endedAt" < "startedAt"',
      "truckId orphelin",
      "chauffeurId orphelin",
      "teamId orphelin",
      "companyId orphelin",
      "enumlabel\" = 'BACKFILL'",
      "pg_constraint",
      "truck_assignments_v1a_open_for_truck_id",
      "truck_assignments_v1b_chronology_check",
      "truck_assignments_v1b_reason_required_check",
    ]) {
      assert.ok(guards.includes(needle), `garde manquant : ${needle}`)
    }
    assert.ok(backfill < alter)
    assert.ok(/RAISE EXCEPTION/.test(guards))
  })

  it("gardes FK : nom, table, colonne, action attendus (CASCADE / SET NULL / SET NULL, ON UPDATE CASCADE)", () => {
    assert.ok(flat.includes("('truck_assignments_truckId_fkey', 'truckId', 'trucks', 'c')"))
    assert.ok(flat.includes("('truck_assignments_chauffeurId_fkey', 'chauffeurId', 'employees', 'n')"))
    assert.ok(flat.includes("('truck_assignments_teamId_fkey', 'teamId', 'teams', 'n')"))
    assert.ok(flat.includes("info.updtype <> 'c'"))
  })

  it("BACKFILL : uniquement reason, uniquement NULL, avant les CHECK, assertion COUNT = 0", () => {
    const updates = executable.match(/UPDATE\s+"[a-z_]+"[\s\S]*?;/g) ?? []
    assert.equal(updates.length, 1)
    assert.match(updates[0].replace(/\s+/g, " "), /^UPDATE "truck_assignments" SET "reason" = 'BACKFILL' WHERE "reason" IS NULL;$/)
    assert.ok(!/\b(DELETE\s+FROM|INSERT\s+INTO|TRUNCATE)\b/i.test(executable))
    assert.ok(idx('UPDATE "truck_assignments"') < idx("truck_assignments_v1b_reason_required_check\" CHECK"))
    assert.ok(flat.includes('SELECT COUNT(*) INTO n FROM "truck_assignments" WHERE "reason" IS NULL; IF n <> 0'))
  })

  it("3 FK → RESTRICT, ON UPDATE CASCADE, noms conservés, dans un seul ALTER TABLE", () => {
    const alter = flat.slice(idx('ALTER TABLE "truck_assignments" DROP CONSTRAINT'))
    const stmt = alter.slice(0, alter.indexOf(";") + 1)
    for (const [col, table] of [["truckId", "trucks"], ["chauffeurId", "employees"], ["teamId", "teams"]]) {
      assert.ok(stmt.includes(`DROP CONSTRAINT "truck_assignments_${col}_fkey"`))
      assert.ok(
        stmt.includes(
          `ADD CONSTRAINT "truck_assignments_${col}_fkey" FOREIGN KEY ("${col}") REFERENCES "${table}"("id") ON DELETE RESTRICT ON UPDATE CASCADE`
        ),
        col
      )
    }
    assert.ok(!/ON DELETE (CASCADE|SET NULL)/.test(stmt))
  })

  it("CHECK chronologie et reason requise, sans NOT VALID", () => {
    assert.ok(
      flat.includes(
        'ADD CONSTRAINT "truck_assignments_v1b_chronology_check" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");'
      )
    )
    assert.ok(flat.includes('ADD CONSTRAINT "truck_assignments_v1b_reason_required_check" CHECK ("reason" IS NOT NULL);'))
    assert.ok(!/NOT VALID/i.test(executable))
  })

  it("assertions finales avant COMMIT (RESTRICT, CHECK validés, zéro NULL, trigger)", () => {
    const last = flat.slice(flat.lastIndexOf("DO $$"))
    assert.ok(last.includes("c.\"confdeltype\" = 'r'"))
    assert.ok(last.includes('c."convalidated"'))
    assert.ok(last.includes('<> 2'))
    assert.ok(last.includes('"reason" IS NULL'))
    assert.ok(last.includes("truck_assignments_v1a_open_for_truck_id"))
    assert.ok(last.indexOf("RAISE EXCEPTION") > 0 && last.indexOf("COMMIT") > last.indexOf("RAISE EXCEPTION"))
  })

  it("ne touche ni trucks.* FK, ni companyId, ni le trigger V1A, ni de colonnes métier", () => {
    assert.ok(!/ALTER TABLE "trucks"/.test(executable))
    assert.ok(!/DROP TRIGGER|DROP FUNCTION|DROP TABLE|DROP COLUMN/i.test(executable))
    assert.ok(!/"truck_assignments_companyId_fkey"/.test(executable))
  })
})
