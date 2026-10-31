/**
 * LOT-ADMIN-REVIEW — contrat statique de la migration 20261031090000_worksite_photos_admin_review (sans base).
 * EXPAND borné : seules les formes ci-dessous sont admises. La migration déjà appliquée du Lot 1 n'est pas modifiée.
 * Les preuves avec base (sondes, rejeu, rollback, service) sont dans admin-review.pg.test.ts.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const ROOT = path.join(process.cwd(), "prisma/migrations")
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8")
const migration = read("20261031090000_worksite_photos_admin_review/migration.sql")
const rollback = read("20261031090000_worksite_photos_admin_review/ROLLBACK.sql")
const lot1 = read("20261030180000_worksite_photos_lot1/migration.sql")

const NEW_COLUMNS: Record<string, "TIMESTAMPTZ(3)" | "TEXT"> = {
  approvedAt: "TIMESTAMPTZ(3)", approvedById: "TEXT", approvedByNameSnapshot: "TEXT",
  rejectRequestedAt: "TIMESTAMPTZ(3)", rejectRequestedById: "TEXT", rejectRequestedByNameSnapshot: "TEXT", rejectedAt: "TIMESTAMPTZ(3)",
  trashRequestedById: "TEXT", trashRequestedByNameSnapshot: "TEXT",
}
const NEW_CHECKS = ["worksite_truck_photos_review_values_check", "worksite_truck_photos_rejected_check", "worksite_truck_photos_reject_timeline_check"]

function splitStatements(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, "")
  const statements: string[] = []
  let current = ""
  let dollarTag: string | null = null
  for (let i = 0; i < withoutComments.length; i++) {
    const tag = withoutComments.slice(i).match(/^\$[A-Za-z_]*\$/)
    if (tag) {
      dollarTag = dollarTag === null ? tag[0] : dollarTag === tag[0] ? null : dollarTag
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

type Kind = "enum_value" | "begin" | "commit" | "add_column" | "create_index" | "add_check" | "replace_guard" | "assertions"
function classify(stmt: string): { kind: Kind; target: string } | { violation: string } {
  let m: RegExpMatchArray | null
  if (stmt === "BEGIN") return { kind: "begin", target: "" }
  if (stmt === "COMMIT") return { kind: "commit", target: "" }
  if (stmt === `ALTER TYPE "WorksitePhotoStatus" ADD VALUE IF NOT EXISTS 'REJECTED'`) return { kind: "enum_value", target: "REJECTED" }
  if ((m = stmt.match(/^ALTER TABLE "worksite_truck_photos" ADD COLUMN "(\w+)" (TIMESTAMPTZ\(3\)|TEXT)$/))) {
    return NEW_COLUMNS[m[1]] === m[2] ? { kind: "add_column", target: m[1] } : { violation: `colonne non admise ${m[1]} ${m[2]}` }
  }
  if ((m = stmt.match(/^CREATE INDEX "(\w+)" ON "worksite_truck_photos"\("companyId", "uploadedAt", "id"\)$/))) return { kind: "create_index", target: m[1] }
  if ((m = stmt.match(/^ALTER TABLE "worksite_truck_photos" ADD CONSTRAINT "(\w+)" CHECK \(/))) return NEW_CHECKS.includes(m[1]) ? { kind: "add_check", target: m[1] } : { violation: `CHECK non admise ${m[1]}` }
  if (/^CREATE OR REPLACE FUNCTION "worksite_photos_guard_photo"\(\) RETURNS trigger LANGUAGE plpgsql AS \$fn\$/.test(stmt)) return { kind: "replace_guard", target: "worksite_photos_guard_photo" }
  if (/^DO \$\$/.test(stmt) && /RAISE EXCEPTION/.test(stmt) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/.test(stmt.replace(/'[^']*'/g, ""))) return { kind: "assertions", target: "" }
  return { violation: `instruction non reconnue : ${stmt.slice(0, 80)}` }
}

const statements = splitStatements(migration)
const classified = statements.map(classify)
const accepted = classified.filter((c): c is { kind: Kind; target: string } => "kind" in c)

function functionBody(sql: string, header: RegExp): string {
  const start = sql.search(header)
  assert.ok(start >= 0, "fonction introuvable")
  const bodyStart = sql.indexOf("$fn$", start) + 4
  return sql.slice(bodyStart, sql.indexOf("$fn$", bodyStart))
}
const lot1Guard = functionBody(lot1, /CREATE FUNCTION "worksite_photos_guard_photo"\(\)/)
const newGuard = functionBody(migration, /CREATE OR REPLACE FUNCTION "worksite_photos_guard_photo"\(\)/)

describe("migration admin_review — contrat statique", () => {
  it("la migration déjà appliquée du Lot 1 est inchangée (empreinte figée)", () => {
    assert.equal(createHash("sha256").update(lot1).digest("hex"), "6e352658eab188c1c8a16234378e058f5c947248d7d6ccfce36eab56e03fafe2")
  })
  it("toutes les instructions sont dans la liste fermée ; valeur d'énumération hors transaction", () => {
    assert.deepEqual(classified.filter((c) => "violation" in c), [])
    const kinds = accepted.map((c) => c.kind)
    assert.equal(kinds[0], "enum_value")
    assert.equal(kinds[1], "begin")
    assert.equal(kinds[kinds.length - 1], "commit")
  })
  it("9 colonnes nullables, 1 index, 3 CHECK, 1 fonction remplacée, 1 bloc d'assertions", () => {
    assert.deepEqual(accepted.filter((c) => c.kind === "add_column").map((c) => c.target).sort(), Object.keys(NEW_COLUMNS).sort())
    assert.equal(accepted.filter((c) => c.kind === "create_index").length, 1)
    assert.deepEqual(accepted.filter((c) => c.kind === "add_check").map((c) => c.target).sort(), [...NEW_CHECKS].sort())
    assert.equal(accepted.filter((c) => c.kind === "replace_guard").length, 1)
    assert.equal(accepted.filter((c) => c.kind === "assertions").length, 1)
    assert.equal(/NOT NULL DEFAULT|SET NOT NULL/.test(migration), false, "aucune colonne obligatoire")
  })
  it("aucune donnée écrite, aucune suppression ; la nouvelle valeur d'enum n'est jamais un littéral typé dans la transaction", () => {
    const outside = migration.replace(/--[^\n]*/g, "").replace(/\$fn\$[\s\S]*?\$fn\$/g, "").replace(/\$\$[\s\S]*?\$\$/g, "").replace(/'[^']*'/g, "")
    assert.equal(/\b(INSERT INTO|UPDATE "|DELETE FROM|DROP |TRUNCATE)/.test(outside), false)
    const checks = statements.filter((s) => /ADD CONSTRAINT/.test(s)).join(" ")
    assert.equal(/"status" (<>|=|IN)\s*\(?'REJECTED'/.test(checks), false, "les CHECK comparent \"status\"::text")
    assert.match(checks, /"status"::text <> 'REJECTED'/)
  })
  it("la fonction remplacée est un SUR-ENSEMBLE du Lot 1 : chaque contrainte, message et clause de transition conservés", () => {
    for (const name of lot1Guard.match(/CONSTRAINT = '(\w+)'/g) ?? []) assert.ok(newGuard.includes(name), `contrainte perdue : ${name}`)
    for (const msg of lot1Guard.match(/RAISE EXCEPTION '[^']*(?:''[^']*)*'/g) ?? []) assert.ok(newGuard.includes(msg), `message perdu : ${msg}`)
    for (const clause of ["(OLD.\"status\" = 'PENDING' AND NEW.\"status\" = 'SENT')", "(OLD.\"status\" = 'SENT' AND NEW.\"status\" = 'DELETED')", "NEW.\"uploadedAt\" := clock_timestamp();"]) {
      assert.ok(newGuard.includes(clause), `clause perdue : ${clause}`)
    }
    // Blocs entiers du Lot 1 recopiés tels quels (identité figée, preuve figée, horodatages monotones).
    for (const marker of ["identité, fichier et auteur d''une photo sont figés", "la preuve d''envoi est figée après SENT", "un horodatage posé ne se modifie plus"]) {
      const lot1Block = lot1Guard.slice(lot1Guard.lastIndexOf("IF ", lot1Guard.indexOf(marker)), lot1Guard.indexOf("END IF;", lot1Guard.indexOf(marker)))
      assert.ok(newGuard.includes(lot1Block), `bloc du Lot 1 modifié : ${marker}`)
    }
  })
  it("ajouts : REJECTED terminal depuis PENDING seul, deux phases, intention bloquant validation et envoi, horodatage base, attribution figée", () => {
    assert.match(newGuard, /\(OLD\."status" = 'PENDING' AND NEW\."status" = 'REJECTED'\)/)
    assert.match(newGuard, /worksite_truck_photos_reject_two_phase_check/)
    assert.match(newGuard, /worksite_truck_photos_reject_blocks_send_check/)
    assert.match(newGuard, /worksite_truck_photos_approval_state_check/)
    assert.match(newGuard, /NEW\."approvedAt" := clock_timestamp\(\);/)
    assert.match(newGuard, /NEW\."rejectRequestedAt" := clock_timestamp\(\);/)
    assert.match(newGuard, /worksite_truck_photos_trash_attribution_check/)
    assert.match(newGuard, /worksite_truck_photos_insert_review_check/)
    assert.equal(/'SENT' AND NEW\."status" = 'REJECTED'/.test(newGuard), false, "une photo envoyée n'est jamais requalifiée REJECTED")
  })
  it("traitement legacy documenté : aucune réécriture, aucune approbation historique inventée", () => {
    assert.match(migration, /aucune n'est réécrite/)
    assert.match(migration, /aucune approbation historique n'est inventée/)
  })
})

describe("ROLLBACK admin_review", () => {
  it("refuse sous verrou toute donnée de revue AVANT toute modification", () => {
    const code = rollback.replace(/--[^\n]*/g, (c) => " ".repeat(c.length))
    const firstChange = code.search(/\b(CREATE OR REPLACE|DROP|ALTER TABLE)\b/)
    const guard = rollback.slice(0, firstChange)
    assert.match(guard, /LOCK TABLE "worksite_truck_photos" IN ACCESS EXCLUSIVE MODE;/)
    for (const marker of ["des photos sont REJECTED", "des photos portent une validation interne", "des photos portent une intention de rejet", "des demandes de suppression sont attribuées"]) {
      assert.match(guard, new RegExp(`ROLLBACK REFUSÉ : ${marker}`))
    }
  })
  it("restaure la fonction de garde du Lot 1 À L'IDENTIQUE, retire les 9 colonnes, l'index, les 3 CHECK, puis l'entrée de migration", () => {
    const restored = functionBody(rollback, /CREATE OR REPLACE FUNCTION "worksite_photos_guard_photo"\(\)/)
    assert.equal(restored, lot1Guard)
    for (const column of Object.keys(NEW_COLUMNS)) assert.match(rollback, new RegExp(`DROP COLUMN IF EXISTS "${column}";`))
    for (const check of NEW_CHECKS) assert.match(rollback, new RegExp(`DROP CONSTRAINT IF EXISTS "${check}";`))
    assert.match(rollback, /DROP INDEX IF EXISTS "worksite_truck_photos_companyId_uploadedAt_id_idx";/)
    assert.ok(rollback.lastIndexOf(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261031090000_worksite_photos_admin_review';`) > rollback.lastIndexOf("DROP COLUMN"))
    assert.equal(/DROP TABLE|DROP TYPE/.test(rollback), false)
  })
})
