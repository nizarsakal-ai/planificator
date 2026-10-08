// Module Tâches V1 — contrôles statiques du schéma Prisma et de la migration (aucune connexion DB).
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const MIGRATION_NAME = "20261008120000_tasks_v1"
const schema = readFileSync("prisma/schema.prisma", "utf8")
const sql = readFileSync(`prisma/migrations/${MIGRATION_NAME}/migration.sql`, "utf8")

function block(kind: "model" | "enum", name: string): string {
  const m = schema.match(new RegExp(`^${kind} ${name} \\{([\\s\\S]*?)^\\}`, "m"))
  assert.ok(m, `${kind} ${name} introuvable`)
  return m[1]
    .split("\n")
    .map((l) => l.replace(/\s*\/\/.*$/, "").trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n")
}

const executable = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
const flat = executable.replace(/\s+/g, " ").trim()

const field = (body: string, name: string) =>
  body.split("\n").find((l) => l.trim().split(/\s+/)[0] === name)?.trim() ?? ""

describe("Tâches — schéma Prisma", () => {
  const task = block("model", "Task")

  it("enums TaskStatus et TaskPriority exacts", () => {
    assert.deepEqual(
      block("enum", "TaskStatus").split("\n").map((l) => l.trim()),
      ["TODO", "IN_PROGRESS", "DONE"]
    )
    assert.deepEqual(
      block("enum", "TaskPriority").split("\n").map((l) => l.trim()),
      ["LOW", "MEDIUM", "HIGH"]
    )
  })

  it("champs obligatoires et types", () => {
    assert.match(field(task, "id"), /^id\s+String\s+@id\s+@default\(cuid\(\)\)$/)
    assert.match(field(task, "companyId"), /^companyId\s+String$/)
    assert.match(field(task, "title"), /^title\s+String$/)
    assert.match(field(task, "description"), /^description\s+String\?$/)
    assert.match(field(task, "createdById"), /^createdById\s+String$/)
    assert.match(field(task, "createdAt"), /^createdAt\s+DateTime\s+@default\(now\(\)\)$/)
    assert.match(field(task, "updatedAt"), /^updatedAt\s+DateTime\s+@updatedAt$/)
  })

  it("statut/priorité avec valeurs par défaut", () => {
    assert.match(field(task, "status"), /^status\s+TaskStatus\s+@default\(TODO\)$/)
    assert.match(field(task, "priority"), /^priority\s+TaskPriority\s+@default\(MEDIUM\)$/)
  })

  it("échéance et références facultatives (nullables)", () => {
    assert.match(field(task, "dueDate"), /^dueDate\s+DateTime\?$/)
    assert.match(field(task, "assigneeId"), /^assigneeId\s+String\?$/)
    assert.match(field(task, "worksiteId"), /^worksiteId\s+String\?$/)
  })

  it("createdById sans FK User (identifiant scalaire)", () => {
    assert.doesNotMatch(task, /createdBy\s+User/)
    assert.doesNotMatch(task, /references:\s*\[id\][^)]*\bUser\b/)
  })

  it("relations : company Cascade, assignee/worksite SetNull", () => {
    assert.match(
      field(task, "company"),
      /^company\s+Company\s+@relation\(fields: \[companyId\], references: \[id\], onDelete: Cascade\)$/
    )
    assert.match(
      field(task, "assignee"),
      /^assignee\s+Employee\?\s+@relation\("TaskAssignee", fields: \[assigneeId\], references: \[id\], onDelete: SetNull\)$/
    )
    assert.match(
      field(task, "worksite"),
      /^worksite\s+Worksite\?\s+@relation\(fields: \[worksiteId\], references: \[id\], onDelete: SetNull\)$/
    )
  })

  it("index attendus", () => {
    assert.match(task, /@@index\(\[companyId, createdAt\]\)/)
    assert.match(task, /@@index\(\[companyId, status\]\)/)
    assert.match(task, /@@index\(\[assigneeId\]\)/)
    assert.match(task, /@@index\(\[worksiteId\]\)/)
    assert.match(task, /@@map\("tasks"\)/)
  })

  it("relations inverses ajoutées sur Company / Employee / Worksite", () => {
    assert.match(block("model", "Company"), /^\s*tasks\s+Task\[\]$/m)
    assert.match(block("model", "Employee"), /^\s*assignedTasks\s+Task\[\]\s+@relation\("TaskAssignee"\)$/m)
    assert.match(block("model", "Worksite"), /^\s*tasks\s+Task\[\]$/m)
  })
})

describe("Tâches — migration SQL", () => {
  it("transaction explicite BEGIN … COMMIT et lock_timeout local", () => {
    assert.match(flat, /^BEGIN; SET LOCAL lock_timeout = '5s';/)
    assert.match(flat, /COMMIT;$/)
    assert.equal((flat.match(/\bBEGIN;/g) ?? []).length, 1)
    assert.equal((flat.match(/\bCOMMIT;/g) ?? []).length, 1)
  })

  it("enums créés", () => {
    assert.match(flat, /CREATE TYPE "TaskStatus" AS ENUM \('TODO', 'IN_PROGRESS', 'DONE'\);/)
    assert.match(flat, /CREATE TYPE "TaskPriority" AS ENUM \('LOW', 'MEDIUM', 'HIGH'\);/)
  })

  it("table tasks avec colonnes, defaults et PK", () => {
    assert.match(flat, /CREATE TABLE "tasks" \(/)
    assert.match(flat, /"companyId" TEXT NOT NULL/)
    assert.match(flat, /"title" TEXT NOT NULL/)
    assert.match(flat, /"description" TEXT,/)
    assert.match(flat, /"status" "TaskStatus" NOT NULL DEFAULT 'TODO'/)
    assert.match(flat, /"priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM'/)
    assert.match(flat, /"dueDate" TIMESTAMP\(3\),/)
    assert.match(flat, /"assigneeId" TEXT,/)
    assert.match(flat, /"worksiteId" TEXT,/)
    assert.match(flat, /"createdById" TEXT NOT NULL/)
    assert.match(flat, /"createdAt" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/)
    assert.match(flat, /"updatedAt" TIMESTAMP\(3\) NOT NULL/)
    assert.match(flat, /CONSTRAINT "tasks_pkey" PRIMARY KEY \("id"\)/)
  })

  it("index correspondant au schéma", () => {
    assert.match(flat, /CREATE INDEX "tasks_companyId_createdAt_idx" ON "tasks"\("companyId", "createdAt"\);/)
    assert.match(flat, /CREATE INDEX "tasks_companyId_status_idx" ON "tasks"\("companyId", "status"\);/)
    assert.match(flat, /CREATE INDEX "tasks_assigneeId_idx" ON "tasks"\("assigneeId"\);/)
    assert.match(flat, /CREATE INDEX "tasks_worksiteId_idx" ON "tasks"\("worksiteId"\);/)
  })

  it("FK : company CASCADE, assignee/worksite SET NULL ; createdById sans FK", () => {
    assert.match(
      flat,
      /ALTER TABLE "tasks" ADD CONSTRAINT "tasks_companyId_fkey" FOREIGN KEY \("companyId"\) REFERENCES "companies"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE;/
    )
    assert.match(
      flat,
      /ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigneeId_fkey" FOREIGN KEY \("assigneeId"\) REFERENCES "employees"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;/
    )
    assert.match(
      flat,
      /ALTER TABLE "tasks" ADD CONSTRAINT "tasks_worksiteId_fkey" FOREIGN KEY \("worksiteId"\) REFERENCES "worksites"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE;/
    )
    assert.doesNotMatch(flat, /"tasks_createdById_fkey"/)
  })

  it("strictement additive : aucune modification de table métier existante", () => {
    // Cible les instructions destructives / de backfill — « ON DELETE/UPDATE » des FK est autorisé.
    assert.doesNotMatch(executable, /\bDROP\b/i)
    assert.doesNotMatch(executable, /\bTRUNCATE\b/i)
    assert.doesNotMatch(executable, /\bDELETE\s+FROM\b/i)
    assert.doesNotMatch(executable, /\bUPDATE\s+"/i)
    assert.doesNotMatch(executable, /\bINSERT\s+INTO\b/i)
    assert.doesNotMatch(executable, /\bRENAME\b/i)
    // Seule la table "tasks" est modifiée (ALTER TABLE), et seulement elle.
    const altered = [...executable.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual([...new Set(altered)], ["tasks"])
    // Les seules tables référencées comme parent de FK sont les tables existantes attendues.
    for (const t of ["trucks", "truck_assignments", "teams"]) {
      assert.ok(!flat.includes(`CREATE TABLE "${t}"`), t)
    }
  })

  it("migration tâches postérieure à la dernière migration véhicules existante à son ajout (V1C)", () => {
    // Des lots véhicules ultérieurs (V2…) peuvent suivre : seule la devancière historique est figée.
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort()
    assert.ok(names.includes(MIGRATION_NAME))
    assert.equal(names[names.indexOf(MIGRATION_NAME) - 1], "20261006220000_vehicles_v1c_modele")
  })

  it("migrations véhicules intactes (non modifiées par ce lot)", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto")
    const sha = (n: string) =>
      createHash("sha256").update(readFileSync(`prisma/migrations/${n}/migration.sql`)).digest("hex")
    assert.equal(sha("20261006220000_vehicles_v1c_modele").length, 64)
  })
})
