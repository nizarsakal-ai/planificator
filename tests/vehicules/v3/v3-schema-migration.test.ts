// V3 Lot 1 — contrat statique Prisma/SQL. Aucune connexion ni migration exécutée.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const NAME = "20261025120000_vehicles_v3_documents"
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

describe("V3 Lot 1 — modèle additif et conservation V1/V2", () => {
  it("les modèles V2 ne changent que par relations inverses et une cible composite", () => {
    assert.doesNotMatch(block("MileageEntry"), /vehicleDocument|VehicleDocument/)
    assert.doesNotMatch(block("MileageTrip"), /^\s*(status|distance|createdAt)\s/m)
    assert.match(block("VehicleMaintenanceEntry"), /@@unique\(\[id, truckId, companyId\], map: "vehicle_maintenance_entries_id_truck_company_key"\)/)
    assert.match(field("Truck", "vehicleDocuments"), /^vehicleDocuments\s+VehicleDocument\[\]$/)
    // Les migrations V2 appliquées ne sont jamais réécrites : empreintes figées.
    const hashes: Record<string, string> = {
      "20261008120000_vehicles_v2_mileage": "358f8adfe234c6771d593d93e19905493ca2054a6a5ebb4c8af7eb98e16eee0f",
      "20261024160000_vehicles_v2_maintenance": "ac6a1fcc6468b8d3fa5ccd228f744f44ffae7724085ab6415d17b2c0a122e2c3",
    }
    for (const [name, expected] of Object.entries(hashes)) {
      assert.equal(createHash("sha256").update(readFileSync(`prisma/migrations/${name}/migration.sql`)).digest("hex"), expected, name)
    }
  })

  it("dossier : rubrique typée, version courante composite, révision, archivage avec auteur", () => {
    assert.match(field("VehicleDocument", "category"), /VehicleDocumentCategory/)
    assert.match(field("VehicleDocument", "currentVersion"), /fields: \[currentVersionId, id, companyId\], references: \[id, documentId, companyId\]/)
    assert.match(field("VehicleDocument", "revision"), /Int\s+@default\(1\)/)
    assert.match(block("VehicleDocument"), /@@unique\(\[id, truckId, companyId\]/)
    for (const relation of block("VehicleDocument").split("\n").filter((line) => line.includes("fields:"))) assert.match(relation, /onDelete: Restrict, onUpdate: Restrict/)
  })

  it("version : fichier privé raw/authenticated, empreinte, dates civiles, kilométrage et intervention facultatifs", () => {
    assert.match(field("VehicleDocumentVersion", "sha256"), /@db\.Char\(64\)/)
    assert.match(field("VehicleDocumentVersion", "validUntil"), /DateTime\?\s+@db\.Date/)
    assert.match(field("VehicleDocumentVersion", "mileage"), /^mileage\s+Int\?$/)
    assert.match(field("VehicleDocumentVersion", "maintenanceEntry"), /fields: \[maintenanceEntryId, truckId, companyId\], references: \[id, truckId, companyId\]/)
    assert.match(field("VehicleDocumentVersion", "idempotencyKey"), /@db\.Uuid/)
    assert.doesNotMatch(block("VehicleDocumentVersion"), /url|Url|@updatedAt/)
    for (const relation of block("VehicleDocumentVersion").split("\n").filter((line) => line.includes("fields:"))) assert.match(relation, /onDelete: Restrict, onUpdate: Restrict/)
  })

  it("rappels : seuils par entreprise, reçu unique version/seuil/destinataire ; audit en ajout seul", () => {
    assert.match(field("VehicleDocumentReminderSetting", "thresholdsDays"), /Int\[\]\s+@default\(\[30, 7\]\)/)
    assert.match(block("VehicleDocumentReminder"), /@@unique\(\[versionId, thresholdDays, recipientUserId\]/)
    assert.match(block("VehicleAuditLog"), /createdAt\s+DateTime\s+@default\(dbgenerated\("clock_timestamp\(\)"\)\)/)
    assert.match(schema, /VEHICLE_DOCUMENT_EXPIRING/)
    assert.match(schema, /VEHICLE_DOCUMENT_EXPIRED/)
  })
})

describe("V3 Lot 1 — contrat migration SQL sans connexion DB", () => {
  it("valeurs d'énumération hors transaction, puis bloc atomique avec gardes et assertions", () => {
    assert.match(flat, /^ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VEHICLE_DOCUMENT_EXPIRING'; ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VEHICLE_DOCUMENT_EXPIRED'; BEGIN; SET LOCAL lock_timeout = '5s'; LOCK TABLE/)
    assert.match(flat, /COMMIT;$/)
    assert.equal((flat.match(/\bBEGIN;/g) ?? []).length, 1)
    assert.equal((flat.match(/\bCOMMIT;/g) ?? []).length, 1)
    assert.ok(flat.indexOf("DO $$") < flat.indexOf("CREATE TYPE"))
    const guards = flat.slice(0, flat.indexOf("CREATE TYPE"))
    for (const prerequisite of ["vehicle_maintenance_entries", "trucks_id_companyId_key", "to_regclass", "RAISE EXCEPTION"]) assert.ok(guards.includes(prerequisite), prerequisite)
    const assertions = flat.slice(flat.lastIndexOf("DO $$"))
    for (const evidence of ["confdeltype = 'r'", "confupdtype = 'r'", "convalidated", "indisvalid", "tgenabled = 'O'", "pg_enum"]) assert.ok(assertions.includes(evidence), evidence)
  })

  it("cinq tables, un index composite sur l'entretien ; aucun INSERT/UPDATE/DELETE métier, DROP ou TRUNCATE", () => {
    assert.deepEqual([...executable.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]),
      ["vehicle_documents", "vehicle_document_versions", "vehicle_document_reminder_settings", "vehicle_document_reminders", "vehicle_audit_logs"])
    assert.doesNotMatch(executable, /\b(?:INSERT\s+INTO|UPDATE\s+"\w+"\s+SET|DELETE\s+FROM|DROP|TRUNCATE)\b/i)
    assert.doesNotMatch(executable, /ALTER TABLE "(trucks|mileage_entries|mileage_trips|truck_assignments|vehicle_maintenance_plans)"/)
    assert.match(flat, /CREATE UNIQUE INDEX "vehicle_maintenance_entries_id_truck_company_key" ON "vehicle_maintenance_entries"\("id", "truckId", "companyId"\)/)
  })

  it("FK toutes RESTRICT et composites tenant-safe", () => {
    const fks = [...flat.matchAll(/ADD CONSTRAINT "([^"]+)" FOREIGN KEY \([^)]+\) REFERENCES "[^"]+"\([^)]+\) ON DELETE (\w+) ON UPDATE (\w+)/g)]
    assert.equal(fks.length, 16)
    for (const fk of fks) assert.deepEqual(fk.slice(2), ["RESTRICT", "RESTRICT"], fk[1])
    assert.match(flat, /FOREIGN KEY \("maintenanceEntryId", "truckId", "companyId"\) REFERENCES "vehicle_maintenance_entries"\("id", "truckId", "companyId"\)/)
    assert.match(flat, /FOREIGN KEY \("currentVersionId", "id", "companyId"\) REFERENCES "vehicle_document_versions"\("id", "documentId", "companyId"\)/)
    assert.match(flat, /FOREIGN KEY \("versionId", "documentId", "companyId"\) REFERENCES "vehicle_document_versions"\("id", "documentId", "companyId"\)/)
  })

  it("CHECK locaux : stockage raw/authenticated, empreintes, bornes et cohérence des dates", () => {
    const checks = flat.slice(flat.indexOf('"vehicle_documents_v3_values_check"'), flat.indexOf("CREATE FUNCTION"))
    assert.doesNotMatch(checks, /\bSELECT\b/)
    for (const clause of [
      `"storageProvider" = 'cloudinary' AND "storageResourceType" = 'raw' AND "storageDeliveryType" = 'authenticated'`,
      `"sha256" ~ '^[0-9a-f]{64}$'`, `"mileage" IS NULL OR "mileage" BETWEEN 0 AND 9999999`,
      `"validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil"`,
      `cardinality("thresholdsDays") BETWEEN 1 AND 6`, `"thresholdDays" BETWEEN -1 AND 3650`,
      `"outcome" IN ('GRANTED', 'DENIED', 'DONE', 'FAILED')`,
    ]) assert.ok(checks.includes(clause), clause)
  })

  it("unicités : numéro de version, idempotence, clé de stockage, reçu de rappel", () => {
    for (const index of [
      `CREATE UNIQUE INDEX "vehicle_document_versions_document_number_key" ON "vehicle_document_versions"("documentId", "versionNumber")`,
      `CREATE UNIQUE INDEX "vehicle_document_versions_company_truck_idempotency_key" ON "vehicle_document_versions"("companyId", "truckId", "idempotencyKey")`,
      `CREATE UNIQUE INDEX "vehicle_document_versions_company_storage_key" ON "vehicle_document_versions"("companyId", "storageKey")`,
      `CREATE UNIQUE INDEX "vehicle_document_reminders_version_threshold_recipient_key" ON "vehicle_document_reminders"("versionId", "thresholdDays", "recipientUserId")`,
    ]) assert.ok(flat.includes(index), index)
  })

  it("triggers : version immuable hors validation/remplacement, dossier jamais supprimé, reçus et audit en ajout seul", () => {
    const version = functionBody("vehicle_documents_v3_guard_version")
    assert.match(version, /TG_OP = 'DELETE'.*RAISE EXCEPTION/)
    assert.ok(version.includes(`NEW."uploadedAt" := clock_timestamp()`))
    for (const column of ["storageKey", "sha256", "validUntil", "mileage", "maintenanceEntryId", "idempotencyKey", "requestHash"]) assert.ok(version.includes(`OLD."${column}"`), column)
    assert.ok(version.includes(`OLD."verifiedAt" IS NOT NULL AND ROW(NEW."verifiedAt"`))
    assert.ok(version.includes(`OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt"`))
    const document = functionBody("vehicle_documents_v3_guard_document")
    assert.match(document, /TG_OP = 'DELETE'.*RAISE EXCEPTION/)
    assert.ok(document.includes(`NEW."revision" < OLD."revision"`))
    assert.ok(document.includes(`OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt"`))
    const append = functionBody("vehicle_documents_v3_append_only")
    assert.match(append, /TG_OP = 'INSERT'.*RETURN NEW/)
    assert.match(flat, /BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_document_reminders" FOR EACH ROW EXECUTE FUNCTION "vehicle_documents_v3_append_only"/)
    assert.match(flat, /BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_audit_logs" FOR EACH ROW EXECUTE FUNCTION "vehicle_documents_v3_append_only"/)
  })

  it("les migrations Documents et intégration V3 sont explicites et les migrations V2 restent intactes", () => {
    const names = readdirSync("prisma/migrations")
    assert.deepEqual(names.filter((name) => name.includes("vehicles_v3")), [NAME, "20261025130000_vehicles_v3_integration"])
    const hashes: Record<string, string> = {
      "20261006180000_vehicles_v1b_db_integrity": "97eb3d59af84277b5637ff72e7ff52ff03afe71478b9121a8753ed901850235b",
      "20261008120000_vehicles_v2_mileage": "358f8adfe234c6771d593d93e19905493ca2054a6a5ebb4c8af7eb98e16eee0f",
      "20261024160000_vehicles_v2_maintenance": "ac6a1fcc6468b8d3fa5ccd228f744f44ffae7724085ab6415d17b2c0a122e2c3",
    }
    for (const [name, expected] of Object.entries(hashes)) {
      assert.equal(createHash("sha256").update(readFileSync(`prisma/migrations/${name}/migration.sql`)).digest("hex"), expected)
    }
  })
})
