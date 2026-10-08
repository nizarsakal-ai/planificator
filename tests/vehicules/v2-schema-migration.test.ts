// Contrat statique Prisma/SQL V2. Aucune connexion PostgreSQL et aucune migration exécutée.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const NAME = "20261008120000_vehicles_v2_mileage"
const schema = readFileSync("prisma/schema.prisma", "utf8")
const sql = readFileSync(`prisma/migrations/${NAME}/migration.sql`, "utf8")
const executable = sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
const flat = executable.replace(/\s+/g, " ").trim()
const block = (name: string) => {
  const found = schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"))
  assert.ok(found, `model ${name}`)
  return found[1].split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n")
}
const field = (name: string, key: string) => block(name).split("\n").find((line) => line.trim().split(/\s+/)[0] === key)?.trim() ?? ""
const functionBody = (name: string) => {
  const found = executable.match(new RegExp(`CREATE FUNCTION "${name}"\\(\\) RETURNS trigger[\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;`))
  assert.ok(found, name)
  return found[1].replace(/\s+/g, " ")
}

describe("V2 — modèle et conservation du domaine V1", () => {
  it("projection inconnue nullable, compteur et révision entiers, journal séparé", () => {
    assert.match(field("Truck", "currentMileage"), /^currentMileage\s+Int\?$/)
    assert.match(field("Truck", "currentMileageEntryId"), /^currentMileageEntryId\s+String\?$/)
    assert.match(field("Truck", "mileageRevision"), /^mileageRevision\s+Int\s+@default\(0\)$/)
    assert.match(field("MileageEntry", "mileage"), /^mileage\s+Int$/)
    assert.doesNotMatch(block("TruckAssignment"), /Mileage|mileage|worksiteId/)
    assert.doesNotMatch(block("MileageTrip"), /^\s*(status|distance|createdAt)\s/m)
  })

  it("dates métier et enregistrement distinctes ; empreinte et clé ont des types DB stricts", () => {
    assert.match(field("MileageEntry", "occurredAt"), /DateTime\?.*@db\.Timestamptz\(3\)/)
    assert.match(field("MileageEntry", "recordedAt"), /DateTime\s+@default\(dbgenerated\("clock_timestamp\(\)"\)\).*@db\.Timestamptz\(3\)/)
    assert.match(field("MileageEntry", "idempotencyKey"), /String\s+@db\.Uuid/)
    assert.match(field("MileageEntry", "requestHash"), /String\s+@db\.Char\(64\)/)
    assert.match(field("MileageEntry", "createdByNameSnapshot"), /^createdByNameSnapshot\s+String$/)
    assert.doesNotMatch(block("MileageEntry"), /@updatedAt/)
  })

  it("les cibles composites existent pour tous les parents du contexte", () => {
    for (const parent of ["Truck", "Worksite", "Team", "Employee"]) {
      assert.match(block(parent), /@@unique\(\[id, companyId\]\)/, parent)
    }
    assert.match(block("MileageEntry"), /@@unique\(\[id, truckId, companyId\]/)
    for (const [relation, id] of [["worksite", "worksiteId"], ["team", "teamId"], ["chauffeur", "chauffeurId"]]) {
      assert.ok(field("MileageTrip", relation).includes(`fields: [${id}, companyId], references: [id, companyId]`))
    }
  })

  it("endpoints, correction et projection ne peuvent changer de véhicule/tenant", () => {
    for (const [model, relation, id] of [
      ["MileageTrip", "startEntry", "startEntryId"], ["MileageTrip", "endEntry", "endEntryId"],
      ["MileageEntry", "rootEntry", "rootEntryId"], ["MileageEntry", "supersedesEntry", "supersedesEntryId"],
    ]) {
      assert.ok(field(model, relation).includes(`fields: [${id}, truckId, companyId], references: [id, truckId, companyId]`))
    }
    assert.match(field("Truck", "currentMileageEntry"), /fields: \[currentMileageEntryId, id, companyId\], references: \[id, truckId, companyId\]/)
    for (const model of ["MileageEntry", "MileageTrip"]) {
      for (const relation of block(model).split("\n").filter((line) => line.includes("fields:"))) {
        assert.match(relation, /onDelete: Restrict, onUpdate: Restrict/)
      }
    }
  })

  it("contexte uniquement sur Trip ; auteur relation User séparée du tenant métier", () => {
    for (const prefix of ["worksite", "team", "chauffeur"]) {
      assert.match(field("MileageTrip", `${prefix}Id`), /String\?/)
      assert.match(field("MileageTrip", `${prefix}NameSnapshot`), /String\?/)
      assert.equal(field("MileageEntry", `${prefix}Id`), "")
    }
    assert.match(field("MileageEntry", "createdBy"), /fields: \[createdById\], references: \[id\]/)
  })

  it("une seule migration V2 ; les migrations historiques restent intactes", () => {
    const names = readdirSync("prisma/migrations")
    assert.deepEqual(names.filter((name) => name.includes("vehicles_v2")), [NAME])
    const hashes: Record<string, string> = {
      "20261006180000_vehicles_v1b_db_integrity": "97eb3d59af84277b5637ff72e7ff52ff03afe71478b9121a8753ed901850235b",
    }
    for (const [name, expected] of Object.entries(hashes)) {
      assert.equal(createHash("sha256").update(readFileSync(`prisma/migrations/${name}/migration.sql`)).digest("hex"), expected)
    }
  })
})

describe("V2 — contrat migration SQL sans connexion DB", () => {
  it("atomique, verrous et gardes précèdent toute mutation ; assertions avant COMMIT", () => {
    assert.match(flat, /^BEGIN; SET LOCAL lock_timeout = '5s'; LOCK TABLE/)
    assert.match(flat, /COMMIT;$/)
    assert.equal((flat.match(/\bBEGIN;/g) ?? []).length, 1)
    assert.equal((flat.match(/\bCOMMIT;/g) ?? []).length, 1)
    assert.ok(flat.indexOf("DO $$") < flat.indexOf("CREATE TYPE"))
    const guards = flat.slice(0, flat.indexOf("CREATE TYPE"))
    for (const prerequisite of ["truck_assignments_v1a_open_for_truck_id", "truck_assignments_v1b_chronology_check", "modele"]) {
      assert.ok(guards.includes(prerequisite))
    }
    assert.ok(guards.includes("to_regclass") && guards.includes("RAISE EXCEPTION"))
    const assertions = flat.slice(flat.lastIndexOf("DO $$"))
    for (const evidence of ["confdeltype = 'r'", "confupdtype = 'r'", "convalidated", "indisvalid", "tgenabled = 'O'", "mileageRevision"]) {
      assert.ok(assertions.includes(evidence), evidence)
    }
  })

  it("deux tables sans données inventées ; aucun INSERT/UPDATE/DELETE métier, DROP ou TRUNCATE", () => {
    assert.deepEqual([...executable.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]), ["mileage_entries", "mileage_trips"])
    assert.doesNotMatch(executable, /\b(?:INSERT\s+INTO|UPDATE\s+"\w+"\s+SET|DELETE\s+FROM|DROP|TRUNCATE)\b/i)
    assert.match(flat, /ADD COLUMN "currentMileage" INTEGER, ADD COLUMN "currentMileageEntryId" TEXT, ADD COLUMN "mileageRevision" INTEGER NOT NULL DEFAULT 0/)
    assert.doesNotMatch(executable, /ALTER TABLE "truck_assignments"/)
  })

  it("FK nouvelles toutes RESTRICT ; aucun cascade ni effacement de référence historique", () => {
    const fks = [...flat.matchAll(/ADD CONSTRAINT "([^"]+)" FOREIGN KEY \([^)]+\) REFERENCES "[^"]+"\([^)]+\) ON DELETE (\w+) ON UPDATE (\w+)/g)]
    assert.equal(fks.length, 13)
    for (const fk of fks) assert.deepEqual(fk.slice(2), ["RESTRICT", "RESTRICT"], fk[1])
    assert.match(flat, /FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\)/)
    assert.match(flat, /FOREIGN KEY \("currentMileageEntryId", "id", "companyId"\) REFERENCES "mileage_entries"\("id", "truckId", "companyId"\)/)
  })

  it("bornes, révision, shape et motifs : CHECK locaux sans requête multi-lignes", () => {
    assert.match(flat, /"mileage_entries_v2_mileage_check" CHECK \("mileage" BETWEEN 0 AND 9999999\)/)
    assert.match(flat, /"mileage_entries_v2_revision_check" CHECK \("revision" > 0\)/)
    assert.match(flat, /"trucks_v2_mileage_revision_check" CHECK \("mileageRevision" >= 0\)/)
    const checks = flat.slice(flat.indexOf('ADD CONSTRAINT "trucks_v2_mileage_projection_check"'), flat.indexOf("CREATE FUNCTION"))
    assert.doesNotMatch(checks, /\bSELECT\b/)
    for (const clause of [
      '"kind" IN (\'READING\', \'DEPARTURE\', \'ARRIVAL\') AND "occurredAt" IS NOT NULL',
      '"correctionReason" IS NULL', '"kind" = \'CORRECTION\' AND "occurredAt" IS NULL',
      '"rootEntryId" IS NOT NULL', '"supersedesEntryId" IS NOT NULL',
      '"correctionReason" IS NOT NULL AND btrim("correctionReason") <> \'\'',
    ]) assert.ok(checks.includes(clause), clause)
  })

  it("idempotence et branches correction protégées par des uniques indépendantes", () => {
    assert.match(flat, /CREATE UNIQUE INDEX "mileage_entries_company_truck_idempotency_key" ON "mileage_entries"\("companyId", "truckId", "idempotencyKey"\)/)
    assert.match(flat, /CREATE UNIQUE INDEX "mileage_entries_supersedes_truck_company_key" ON "mileage_entries"\("supersedesEntryId", "truckId", "companyId"\)/)
    assert.match(flat, /CREATE UNIQUE INDEX "mileage_entries_company_truck_revision_key" ON "mileage_entries"\("companyId", "truckId", "revision"\)/)
  })

  it("une seule ouverture par véhicule et endpoints distincts", () => {
    assert.match(flat, /CREATE UNIQUE INDEX "mileage_trips_v2_open_truck_key" ON "mileage_trips"\("companyId", "truckId"\) WHERE "endEntryId" IS NULL/)
    assert.match(flat, /"mileage_trips_v2_endpoints_check" CHECK \("endEntryId" IS NULL OR "startEntryId" <> "endEntryId"\)/)
  })

  it("journal immuable, recordedAt serveur, racine originale et prédécesseur de même chaîne", () => {
    assert.match(flat, /BEFORE UPDATE OR DELETE ON "mileage_entries" FOR EACH ROW EXECUTE FUNCTION "mileage_entries_v2_reject_mutation"/)
    assert.match(functionBody("mileage_entries_v2_reject_mutation"), /RAISE EXCEPTION.*23514.*mileage_entries_v2_immutable_check/)
    const insert = functionBody("mileage_entries_v2_validate_insert")
    assert.ok(insert.includes('NEW."recordedAt" := clock_timestamp()'))
    assert.ok(insert.includes('root_row."kind" = \'CORRECTION\''))
    assert.ok(insert.includes('previous_row."rootEntryId" = root_row."id"'))
    assert.ok(insert.includes('NEW."revision" <= previous_row."revision"'))
    assert.equal((insert.match(/AND "truckId" = NEW\."truckId" AND "companyId" = NEW\."companyId"/g) ?? []).length, 2)
  })

  it("le trajet ne permet ni suppression, ni remplacement du contexte, ni deuxième clôture", () => {
    const guard = functionBody("mileage_trips_v2_guard")
    assert.match(guard, /TG_OP = 'DELETE'.*RAISE EXCEPTION/)
    assert.match(guard, /IS DISTINCT FROM ROW\(OLD\."id"/)
    assert.match(guard, /OLD\."endEntryId" IS NOT NULL OR NEW\."endEntryId" IS NULL/)
    for (const name of ["startEntryId", "worksiteId", "teamId", "chauffeurId", "worksiteNameSnapshot", "teamNameSnapshot", "chauffeurNameSnapshot"]) {
      assert.ok(guard.includes(`OLD."${name}"`))
    }
    assert.ok(guard.includes('start_row."kind" <> \'DEPARTURE\''))
    assert.ok(guard.includes('end_row."kind" <> \'ARRIVAL\''))
    assert.ok(guard.includes('end_row."occurredAt" < start_row."occurredAt"'))
    assert.doesNotMatch(guard, /end_row\."mileage"\s*</) // les corrections peuvent changer le départ effectif
  })

  it("archive/ouverture partagent le verrou Truck et refusent un snapshot d'une autre isolation", () => {
    const trip = functionBody("mileage_trips_v2_guard")
    const archive = functionBody("trucks_v2_guard_archive")
    for (const body of [trip, archive]) {
      assert.ok(body.includes("current_setting('transaction_isolation') <> 'read committed'"))
      assert.ok(body.includes("ERRCODE = '25000'"))
    }
    assert.match(trip, /FROM "trucks" WHERE "id" = NEW\."truckId" AND "companyId" = NEW\."companyId" FOR UPDATE/)
    assert.match(trip, /TG_OP = 'INSERT' AND NOT truck_active/)
    assert.match(archive, /"truckId" = NEW\."id" AND "companyId" = NEW\."companyId" AND "endEntryId" IS NULL/)
    assert.match(archive, /CONSTRAINT = 'trucks_v2_no_open_mileage_trip_check'/)
    assert.match(flat, /BEFORE UPDATE OF "active" ON "trucks" FOR EACH ROW WHEN \(NEW\."active" = false\)/)
  })
})
