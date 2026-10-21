/**
 * PLAN-AGENT-GATEWAY-001 — LOT-1A — T-MIG-3 (assertions textuelles, sans base).
 * La migration agent_gateway_foundation est EXPAND et bornée aux objets agent_* :
 * liste fermée d'instructions admises (voir migration-guard.ts), toute autre instruction est rejetée.
 * Les tests avec base (T-MIG-1/2/4/5, T-SCHEMA-3) sont décrits dans docs/specs/agent-gateway/LOT-1A.md.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { AGENT_TABLES, AGENT_TYPES, splitStatements, validateMigration } from "./migration-guard"

const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20261021150000_agent_gateway_foundation/migration.sql"
)
const sql = readFileSync(MIGRATION, "utf8")
const result = validateMigration(sql)

describe("T-MIG-3 — migration agent_gateway_foundation bornée (liste fermée)", () => {
  it("toutes les instructions sont dans la liste fermée ; aucune violation", () => {
    assert.deepEqual(result.violations, [])
    assert.equal(result.accepted.length, splitStatements(sql).length)
    assert.ok(result.accepted.length > 0)
  })

  it("crée exactement les 3 types et les 5 tables attendus, et rien d'autre", () => {
    const types = result.accepted.filter((s) => s.kind === "create_type").map((s) => s.target)
    const tables = result.accepted.filter((s) => s.kind === "create_table").map((s) => s.target)
    assert.deepEqual(types.sort(), [...AGENT_TYPES].sort())
    assert.deepEqual(tables.sort(), [...AGENT_TABLES].sort())
    const kinds = new Set(result.accepted.map((s) => s.kind))
    assert.deepEqual([...kinds].sort(), ["add_foreign_key", "create_index", "create_table", "create_type"])
  })

  it("exactement 4 FK, toutes portées par des tables agent_*, vers agent_principals / companies / users", () => {
    const fks = result.accepted.filter((s) => s.kind === "add_foreign_key")
    assert.equal(fks.length, 4)
    const targets = fks.map((s) => s.sql.match(/REFERENCES "(\w+)"/)![1]).sort()
    assert.deepEqual(targets, ["agent_principals", "agent_principals", "companies", "users"])
  })

  it("comportements de suppression conformes à la SPEC (Restrict / SetNull / Cascade)", () => {
    assert.match(sql, /"agent_principals_companyId_fkey"[^;]*ON DELETE RESTRICT/)
    assert.match(sql, /"agent_principals_createdByUserId_fkey"[^;]*ON DELETE RESTRICT/)
    assert.match(sql, /"agent_access_logs_principalId_fkey"[^;]*ON DELETE SET NULL/)
    assert.match(sql, /"agent_rate_windows_principalId_fkey"[^;]*ON DELETE CASCADE/)
  })

  it("AgentScope ne contient aucune valeur d'écriture ; AgentGatewayControl désactivé par défaut", () => {
    const scope = sql.match(/CREATE TYPE "AgentScope" AS ENUM \(([^)]*)\)/)![1]
    assert.equal(/WRITE/.test(scope), false)
    assert.match(sql, /"enabled" BOOLEAN NOT NULL DEFAULT false/)
  })
})

describe("T-MIG-3bis — le garde-fou rejette toute instruction hors périmètre (test discriminant)", () => {
  const injected: ReadonlyArray<readonly [string, string]> = [
    ["UPDATE sur companies (reproduction revue Codex)", `UPDATE "companies" SET "name" = 'changed-by-migration';`],
    ["INSERT hors périmètre", `INSERT INTO "users" ("id") VALUES ('x');`],
    ["INSERT dans une table du lot (données, pas structure)", `INSERT INTO "agent_gateway_control" ("id", "enabled", "updatedAt") VALUES ('singleton', true, now());`],
    ["DELETE", `DELETE FROM "companies";`],
    ["DROP TABLE", `DROP TABLE "agent_access_logs";`],
    ["ALTER TABLE sur une table existante", `ALTER TABLE "companies" ADD COLUMN "agentEnabled" BOOLEAN NOT NULL DEFAULT false;`],
    ["ALTER TABLE agent_* hors forme FK", `ALTER TABLE "agent_principals" DROP COLUMN "tokenPrefix";`],
    ["FK vers une table non admise", `ALTER TABLE "agent_access_logs" ADD CONSTRAINT "x_fkey" FOREIGN KEY ("companyId") REFERENCES "worksites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`],
    ["FK sur une table existante", `ALTER TABLE "companies" ADD CONSTRAINT "x_fkey" FOREIGN KEY ("id") REFERENCES "agent_principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`],
    ["index sur une table existante", `CREATE INDEX "companies_name_idx" ON "companies"("name");`],
    ["CREATE TABLE hors périmètre", `CREATE TABLE "agent_shadow" ("id" TEXT NOT NULL, CONSTRAINT "agent_shadow_pkey" PRIMARY KEY ("id"));`],
    ["CREATE TYPE hors périmètre", `CREATE TYPE "AgentWriteScope" AS ENUM ('WORKSITES_WRITE');`],
    ["ALTER TYPE (ajout de valeur d'enum)", `ALTER TYPE "AgentScope" ADD VALUE 'WORKSITES_WRITE';`],
    ["ALTER INDEX RENAME (dérive préexistante exclue)", `ALTER INDEX "x_idx" RENAME TO "y_idx";`],
    ["instruction inconnue", `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`],
    ["fonction / trigger", `CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;`],
    ["GRANT", `GRANT ALL ON "agent_principals" TO PUBLIC;`],
    ["instruction masquée derrière un commentaire", `-- rien\nUPDATE "companies" SET "name" = 'x'; -- fin`],
  ]

  for (const [label, stmt] of injected) {
    it(`rejette : ${label}`, () => {
      const tampered = `${sql}\n${stmt}\n`
      const r = validateMigration(tampered)
      assert.ok(r.violations.length >= 1, `aucune violation détectée pour : ${label}`)
      assert.equal(r.accepted.length, result.accepted.length, "l'instruction injectée ne doit pas être acceptée")
    })
  }

  it("rejette une instruction insérée au milieu, pas seulement en fin de fichier", () => {
    const marker = "-- CreateIndex"
    const idx = sql.indexOf(marker)
    assert.ok(idx > 0)
    const tampered = `${sql.slice(0, idx)}UPDATE "companies" SET "name" = 'x';\n${sql.slice(idx)}`
    assert.ok(validateMigration(tampered).violations.length >= 1)
  })

  it("rejette une colonne REFERENCES inline dans un CREATE TABLE agent_*", () => {
    const tampered = sql.replace(
      `"companyId" TEXT NOT NULL,\n    "name" TEXT NOT NULL,`,
      `"companyId" TEXT NOT NULL REFERENCES "companies"("id"),\n    "name" TEXT NOT NULL,`
    )
    assert.notEqual(tampered, sql)
    assert.ok(validateMigration(tampered).violations.length >= 1)
  })

  it("rejette un type de colonne hors liste (ex. JSONB) dans une table agent_*", () => {
    const tampered = sql.replace(`"tool" TEXT NOT NULL,`, `"tool" JSONB NOT NULL,`)
    assert.notEqual(tampered, sql)
    assert.ok(validateMigration(tampered).violations.length >= 1)
  })

  it("une migration vide n'est pas conforme (aucune instruction acceptée)", () => {
    const r = validateMigration("-- vide\n")
    assert.equal(r.accepted.length, 0)
  })
})
