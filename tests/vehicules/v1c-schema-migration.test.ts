// VEHICLES V1C — contrôles statiques du schéma Prisma et de la migration `modele` (aucune connexion DB).
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const MIGRATION_NAME = "20261006220000_vehicles_v1c_modele"
const schema = readFileSync("prisma/schema.prisma", "utf8")
const sql = readFileSync(`prisma/migrations/${MIGRATION_NAME}/migration.sql`, "utf8")

const executable = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
const flat = executable.replace(/\s+/g, " ").trim()

const truck = schema.match(/^model Truck \{([\s\S]*?)^\}/m)?.[1] ?? ""
const field = (name: string) =>
  truck.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).find((l) => l.split(/\s+/)[0] === name) ?? ""

describe("V1C — schéma Prisma", () => {
  it("Truck.modele String? (nullable, sans défaut, sans @map) ; marque et matricule inchangés", () => {
    assert.match(field("modele"), /^modele\s+String\?$/)
    assert.match(field("marque"), /^marque\s+String\?$/)
    assert.match(field("matricule"), /^matricule\s+String$/)
  })

  it("relations et contraintes Truck inchangées (équipe unique, company RESTRICT, historique V1B-db)", () => {
    assert.match(truck, /@@unique\(\[matricule, companyId\]\)/)
    assert.match(field("team"), /onDelete: SetNull/)
    assert.match(field("chauffeur"), /onDelete: SetNull/)
    assert.match(field("company"), /onDelete: Restrict/)
    const ta = schema.match(/^model TruckAssignment \{([\s\S]*?)^\}/m)?.[1] ?? ""
    for (const r of ["truck", "chauffeur", "team", "company"]) {
      assert.match(ta.split("\n").find((l) => l.trim().startsWith(`${r} `) && l.includes("@relation")) ?? "", /onDelete: Restrict/)
    }
  })

  it("V1C n'introduit pas de kilométrage ; un lot ultérieur peut ajouter la projection et le journal", () => {
    for (const token of ["mileage", "currentMileage", "MileageEntry", "MileageTrip", "odometer", "kilometrage"]) {
      assert.doesNotMatch(executable, new RegExp(token, "i"), `SQL V1C: ${token}`)
    }
    // Le token exact `mileage` est insuffisant : currentMileage ne le contient pas comme champ entier.
    // Identifiants qu'un lot postérieur peut poser. Tout autre kilométrage sur Truck fait échouer le test.
    const allowedLater = [
      "trucks_current_mileage_entry_truck_company_key",
      "trucks_current_mileage_entry_fkey",
      "currentMileageEntryId",
      "currentMileageEntry",
      "TruckMileageEntries",
      "TruckMileageTrips",
      "TruckCurrentMileage",
      "mileageRevision",
      "mileageEntries",
      "mileageTrips",
      "currentMileage",
      "MileageEntry",
      "MileageTrip",
    ]
    for (const line of truck.split("\n").map((value) => value.replace(/\/\/.*$/, "").trim())) {
      if (!/mileage|odometer|kilometrage/i.test(line)) continue
      let residual = line
      for (const token of allowedLater) residual = residual.replaceAll(token, "")
      assert.equal(/mileage|odometer|kilometrage/i.test(residual), false, line)
    }
    for (const name of ["odometer", "kilometrage", "vin", "maintenance", "controleTechnique", "brand", "model"]) {
      assert.equal(field(name), "", name)
    }
  })

  it("migration V1C présente et postérieure à V1B-db", () => {
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort()
    assert.ok(names.includes(MIGRATION_NAME))
    assert.ok(names.indexOf(MIGRATION_NAME) > names.indexOf("20261006180000_vehicles_v1b_db_integrity"))
  })
})

describe("V1C — migration additive", () => {
  it("transaction explicite, lock_timeout local, un seul COMMIT", () => {
    assert.match(flat, /^BEGIN; SET LOCAL lock_timeout = '5s';/)
    assert.match(flat, /COMMIT;$/)
    assert.equal((flat.match(/\bBEGIN;/g) ?? []).length, 1)
    assert.equal((flat.match(/\bCOMMIT;/g) ?? []).length, 1)
  })

  it("une seule instruction métier : ALTER TABLE trucks ADD COLUMN modele TEXT", () => {
    const stmts = flat
      .replace(/^BEGIN; SET LOCAL lock_timeout = '5s';/, "")
      .replace(/COMMIT;$/, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
    assert.deepEqual(stmts, ['ALTER TABLE "trucks" ADD COLUMN "modele" TEXT'])
  })

  it("nullable : ni DEFAULT, ni NOT NULL", () => {
    assert.doesNotMatch(executable, /\bDEFAULT\b/i)
    assert.doesNotMatch(executable, /\bNOT NULL\b/i)
  })

  it("aucun UPDATE / backfill / INSERT / DELETE / DROP / RENAME / TRUNCATE", () => {
    for (const re of [/\bUPDATE\b/i, /\bINSERT\b/i, /\bDELETE\b/i, /\bDROP\b/i, /\bRENAME\b/i, /\bTRUNCATE\b/i]) {
      assert.doesNotMatch(executable, re)
    }
  })

  it("aucune FK, CHECK, index, trigger ni table autre que trucks", () => {
    assert.doesNotMatch(executable, /FOREIGN KEY|CONSTRAINT|\bCHECK\b|CREATE (UNIQUE )?INDEX|TRIGGER|FUNCTION|TYPE/i)
    assert.doesNotMatch(executable, /truck_assignments|"employees"|"teams"|"companies"/)
    assert.doesNotMatch(executable, /"marque"/)
  })

  it("migrations V1A et V1B-db intactes (fichiers immuables)", () => {
    const sha = (n: string) => {
      const { createHash } = require("node:crypto") as typeof import("node:crypto")
      return createHash("sha256").update(readFileSync(`prisma/migrations/${n}/migration.sql`)).digest("hex")
    }
    assert.equal(sha("20261006180000_vehicles_v1b_db_integrity"), "97eb3d59af84277b5637ff72e7ff52ff03afe71478b9121a8753ed901850235b")
  })
})
