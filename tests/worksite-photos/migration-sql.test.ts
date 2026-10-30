/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 1 — contrat statique de la migration worksite_photos_lot1 (sans base).
 * Migration EXPAND bornée : seules les formes et cibles admises ci-dessous ; toute autre instruction est une violation.
 * Les preuves avec base (rejeu de l'historique, CHECK, déclencheurs, FK) sont dans migration.pg.test.ts.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const DIR = path.join(process.cwd(), "prisma/migrations/20261030180000_worksite_photos_lot1")
const migration = readFileSync(path.join(DIR, "migration.sql"), "utf8")
const rollback = readFileSync(path.join(DIR, "ROLLBACK.sql"), "utf8")

export const PHOTO_TABLES = [
  "worksite_truck_photos",
  "worksite_photo_upload_reservations",
  "worksite_photo_events",
  "worksite_photo_drive_connections",
  "worksite_photo_drive_folders",
] as const
export const PHOTO_TYPES = [
  "WorksitePhotoPhase", "WorksitePhotoStatus", "WorksitePhotoReservationState",
  "WorksitePhotoReservationCloseReason", "WorksitePhotoDriveFolderState", "WorksitePhotoDriveConnectionStatus",
] as const
const ALLOWED_FK_TARGETS = ["companies", "worksites", "trucks", ...PHOTO_TABLES]
const TRIGGER_FUNCTIONS = ["worksite_photos_guard_photo", "worksite_photos_guard_reservation", "worksite_photos_append_only", "worksite_photos_check_publication"]

/** Découpe hors commentaires et hors corps `$fn$ … $fn$` / `$$ … $$` (qui contiennent des `;`). */
function splitStatements(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, "")
  const statements: string[] = []
  let current = ""
  let dollarTag: string | null = null
  for (let i = 0; i < withoutComments.length; i++) {
    const rest = withoutComments.slice(i)
    const tag = rest.match(/^\$[A-Za-z_]*\$/)
    if (tag) {
      if (dollarTag === null) dollarTag = tag[0]
      else if (dollarTag === tag[0]) dollarTag = null
      current += tag[0]
      i += tag[0].length - 1
      continue
    }
    const ch = withoutComments[i]
    if (ch === ";" && dollarTag === null) { statements.push(current.replace(/\s+/g, " ").trim()); current = "" }
    else current += ch
  }
  if (current.trim()) statements.push(current.replace(/\s+/g, " ").trim())
  return statements.filter((s) => s.length > 0)
}

const isPhotoTable = (t: string) => (PHOTO_TABLES as readonly string[]).includes(t)
const isPhotoType = (t: string) => (PHOTO_TYPES as readonly string[]).includes(t)

type Kind = "enum_value" | "begin" | "commit" | "create_type" | "alter_worksites_add_column" | "create_table" | "create_index"
  | "add_foreign_key" | "add_check" | "create_function" | "create_trigger" | "create_constraint_trigger" | "assertions"

function classify(stmt: string): { kind: Kind; target: string } | { violation: string } {
  let m: RegExpMatchArray | null
  if (/^BEGIN$/.test(stmt)) return { kind: "begin", target: "" }
  if (/^COMMIT$/.test(stmt)) return { kind: "commit", target: "" }
  if ((m = stmt.match(/^ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WORKSITE_PHOTO_UNSENT'$/))) return { kind: "enum_value", target: "NotificationType" }
  if ((m = stmt.match(/^CREATE TYPE "(\w+)" AS ENUM \((?:\s*'[A-Z_]+'\s*,?)+\)$/))) return isPhotoType(m[1]) ? { kind: "create_type", target: m[1] } : { violation: `type hors lot ${m[1]}` }
  if (/^ALTER TABLE "worksites" ADD COLUMN "clientContact" TEXT$/.test(stmt)) return { kind: "alter_worksites_add_column", target: "worksites" }
  if ((m = stmt.match(/^CREATE TABLE "(\w+)" \(/))) return isPhotoTable(m[1]) ? { kind: "create_table", target: m[1] } : { violation: `table hors lot ${m[1]}` }
  if ((m = stmt.match(/^CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)"\(.+\)(?: NULLS NOT DISTINCT)?$/))) return isPhotoTable(m[1]) ? { kind: "create_index", target: m[1] } : { violation: `index hors lot ${m[1]}` }
  if ((m = stmt.match(/^ALTER TABLE "(\w+)" ADD CONSTRAINT "\w+" FOREIGN KEY \([^)]+\) REFERENCES "(\w+)"\([^)]+\) ON DELETE RESTRICT ON UPDATE RESTRICT$/))) {
    if (!isPhotoTable(m[1])) return { violation: `FK posée sur une table existante ${m[1]}` }
    if (!ALLOWED_FK_TARGETS.includes(m[2])) return { violation: `FK vers cible non admise ${m[2]}` }
    return { kind: "add_foreign_key", target: m[2] }
  }
  if ((m = stmt.match(/^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" CHECK \(/))) return isPhotoTable(m[1]) && m[2].startsWith("worksite_") ? { kind: "add_check", target: m[1] } : { violation: `CHECK hors lot ${m[1]}` }
  if ((m = stmt.match(/^CREATE FUNCTION "(\w+)"\(\) RETURNS trigger LANGUAGE plpgsql AS \$fn\$/))) return TRIGGER_FUNCTIONS.includes(m[1]) ? { kind: "create_function", target: m[1] } : { violation: `fonction hors lot ${m[1]}` }
  if ((m = stmt.match(/^CREATE TRIGGER "\w+" BEFORE INSERT OR UPDATE OR DELETE ON "(\w+)" FOR EACH ROW EXECUTE FUNCTION "(\w+)"\(\)$/))) {
    return isPhotoTable(m[1]) && TRIGGER_FUNCTIONS.includes(m[2]) ? { kind: "create_trigger", target: m[1] } : { violation: `déclencheur hors lot ${m[1]}` }
  }
  // Contrainte différée de publication (L1-R1) : AFTER INSERT photo / AFTER UPDATE OF state réservation, DEFERRABLE INITIALLY DEFERRED.
  if ((m = stmt.match(/^CREATE CONSTRAINT TRIGGER "\w+" AFTER (?:INSERT|UPDATE OF "state") ON "(\w+)" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "worksite_photos_check_publication"\(\)$/))) {
    return isPhotoTable(m[1]) ? { kind: "create_constraint_trigger", target: m[1] } : { violation: `contrainte différée hors lot ${m[1]}` }
  }
  if (/^DO \$\$/.test(stmt) && /RAISE EXCEPTION/.test(stmt) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/.test(stmt.replace(/'[^']*'/g, ""))) return { kind: "assertions", target: "" }
  return { violation: `instruction non reconnue : ${stmt.slice(0, 80)}` }
}

const statements = splitStatements(migration)
const classified = statements.map(classify)
const violations = classified.filter((c): c is { violation: string } => "violation" in c)
const accepted = classified.filter((c): c is { kind: Kind; target: string } => "kind" in c)

describe("migration worksite_photos_lot1 — contrat statique", () => {
  it("toutes les instructions sont dans la liste fermée", () => {
    assert.deepEqual(violations, [])
    assert.equal(accepted.length, statements.length)
  })
  it("la valeur d'énumération est ajoutée hors transaction, avant BEGIN", () => {
    const kinds = accepted.map((c) => c.kind)
    assert.equal(kinds[0], "enum_value")
    assert.equal(kinds[1], "begin")
    assert.equal(kinds[kinds.length - 1], "commit")
    assert.equal(kinds.filter((k) => k === "begin").length, 1)
  })
  it("crée exactement les 6 types et les 5 tables du lot ; une seule modification d'une table existante (colonne nullable)", () => {
    assert.deepEqual(accepted.filter((c) => c.kind === "create_type").map((c) => c.target).sort(), [...PHOTO_TYPES].sort())
    assert.deepEqual(accepted.filter((c) => c.kind === "create_table").map((c) => c.target).sort(), [...PHOTO_TABLES].sort())
    assert.equal(accepted.filter((c) => c.kind === "alter_worksites_add_column").length, 1)
  })
  it("9 FK, toutes RESTRICT, posées sur les tables du lot, vers companies / worksites / trucks / tables du lot", () => {
    const fks = accepted.filter((c) => c.kind === "add_foreign_key")
    assert.equal(fks.length, 9)
    assert.deepEqual([...new Set(fks.map((c) => c.target))].sort(), ["companies", "trucks", "worksite_photo_upload_reservations", "worksite_truck_photos", "worksites"])
    assert.equal(/ON DELETE (CASCADE|SET NULL)/.test(migration), false)
  })
  it("contraintes CHECK et déclencheurs attendus", () => {
    const checks = accepted.filter((c) => c.kind === "add_check")
    assert.equal(checks.length, 7)
    assert.deepEqual(accepted.filter((c) => c.kind === "create_function").map((c) => c.target).sort(), [...TRIGGER_FUNCTIONS].sort())
    assert.deepEqual(accepted.filter((c) => c.kind === "create_trigger").map((c) => c.target).sort(), ["worksite_photo_events", "worksite_photo_upload_reservations", "worksite_truck_photos"])
    assert.deepEqual(accepted.filter((c) => c.kind === "create_constraint_trigger").map((c) => c.target).sort(), ["worksite_photo_upload_reservations", "worksite_truck_photos"])
    assert.match(migration, /FOR SHARE;\s*IF NOT FOUND OR r\."state" <> 'COMMITTED' OR r\."photoId" <> NEW\."id" OR r\."driveFileId" <> NEW\."driveFileId"/, "la photo exige SA réservation COMMITTED, verrouillée")
    assert.match(migration, /NEW\."state" <> 'COMMITTED' AND EXISTS \(SELECT 1 FROM "worksite_truck_photos" p WHERE p\."reservationId" = OLD\."id"/, "une réservation rattachée ne quitte pas COMMITTED")
    assert.match(migration, /IF n <> 5 THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: 5 déclencheurs attendus/)
    assert.equal(accepted.filter((c) => c.kind === "assertions").length, 1)
  })
  it("index unique d'identité des dossiers en NULLS NOT DISTINCT", () => {
    assert.match(migration, /"worksite_photo_drive_folders_companyId_worksiteId_day_key" ON "worksite_photo_drive_folders"\("companyId", "worksiteId", "day"\) NULLS NOT DISTINCT;/)
  })
  it("aucune donnée, aucune suppression, aucune écriture sur l'existant", () => {
    const outsideStrings = migration.replace(/--[^\n]*/g, "").replace(/\$fn\$[\s\S]*?\$fn\$/g, "").replace(/\$\$[\s\S]*?\$\$/g, "").replace(/'[^']*'/g, "")
    assert.equal(/\b(INSERT INTO|UPDATE "|DELETE FROM|DROP |TRUNCATE)/.test(outsideStrings), false)
  })
  it("la preuve d'envoi complète et le cycle PENDING→SENT→DELETED sont contraints en SQL", () => {
    assert.match(migration, /"status" <> 'SENT' OR \(\s*"sentAt" IS NOT NULL AND "sentTo" IS NOT NULL AND "sentMessageId" IS NOT NULL\s*AND "sentTransportKind" IS NOT NULL AND "sentByAgent" IS NOT NULL/)
    assert.match(migration, /\(OLD\."status" = 'PENDING' AND NEW\."status" = 'SENT'\)/)
    assert.match(migration, /\(OLD\."status" = 'SENT' AND NEW\."status" = 'DELETED'\)/)
    assert.match(migration, /la preuve d''envoi est figée après SENT/)
    assert.match(migration, /depuis ABANDONED, seule une clôture OPERATOR est possible/)
  })
})

describe("ROLLBACK.sql — retrait borné aux objets du lot", () => {
  it("supprime exactement les tables, types, fonctions et déclencheurs du lot, la colonne et la ligne de migration", () => {
    for (const table of PHOTO_TABLES) assert.match(rollback, new RegExp(`DROP TABLE IF EXISTS "${table}";`))
    for (const type of PHOTO_TYPES) assert.match(rollback, new RegExp(`DROP TYPE IF EXISTS "${type}";`))
    for (const fn of TRIGGER_FUNCTIONS) assert.match(rollback, new RegExp(`DROP FUNCTION IF EXISTS "${fn}"\\(\\);`))
    assert.match(rollback, /ALTER TABLE "worksites" DROP COLUMN IF EXISTS "clientContact";/)
    assert.match(rollback, /DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030180000_worksite_photos_lot1';/)
    const drops = rollback.match(/DROP (TABLE|TYPE|FUNCTION|TRIGGER) IF EXISTS "(\w+)"/g) ?? []
    for (const drop of drops) {
      const name = drop.match(/"(\w+)"$/)![1]
      assert.ok(isPhotoTable(name) || isPhotoType(name) || TRIGGER_FUNCTIONS.includes(name) || /^worksite_/.test(name), `objet hors lot dans le rollback : ${name}`)
    }
    assert.equal(/DROP TABLE IF EXISTS "(companies|worksites|trucks|users)"/.test(rollback), false)
  })
  it("refuse sous verrou toute donnée AVANT le premier DROP (L1-R2) : cinq tables et clientContact contrôlés", () => {
    const code = rollback.replace(/--[^\n]*/g, (c) => " ".repeat(c.length)) // commentaires neutralisés, positions conservées
    const firstDrop = code.search(/\bDROP\b/)
    const guard = rollback.slice(0, firstDrop)
    assert.match(guard, /LOCK TABLE "worksite_photo_events", "worksite_truck_photos", "worksite_photo_upload_reservations",\s*"worksite_photo_drive_folders", "worksite_photo_drive_connections" IN ACCESS EXCLUSIVE MODE;/)
    assert.match(guard, /LOCK TABLE "worksites" IN SHARE ROW EXCLUSIVE MODE;/)
    for (const table of PHOTO_TABLES) assert.match(guard, new RegExp(`IF EXISTS \\(SELECT 1 FROM "${table}"\\) THEN\\s*RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ`), table)
    assert.match(guard, /IF EXISTS \(SELECT 1 FROM "worksites" WHERE "clientContact" IS NOT NULL\) THEN\s*RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ/)
    assert.ok(rollback.indexOf("BEGIN;") < rollback.indexOf("LOCK TABLE"), "verrous dans la transaction")
    assert.ok(rollback.lastIndexOf('DELETE FROM "_prisma_migrations"') > firstDrop, "l'entrée de migration part en dernier")
  })
})
