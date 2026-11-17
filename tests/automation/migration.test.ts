/**
 * Lot E Planificator V2 : contrôles statiques (migration additive, seule évolution d'un type existant = valeur
 * d'énumération, clés composites, CHECK, déclencheurs), gardes, et absence de tout envoi externe dans les
 * automatisations.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const sql = readFileSync("prisma/migrations/20261115120000_v2_lot_e_crm_automations/migration.sql", "utf8")
const schema = readFileSync("prisma/schema.prisma", "utf8")
const NEW_TABLES = ["opportunities", "opportunity_events", "automation_rules", "automation_runs"]
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const read = (f: string) => readFileSync(f, "utf8")

describe("migration du lot E", () => {
  it("additive : seule évolution d'un objet existant = ajout de la valeur 'AUTOMATION' à NotificationType", () => {
    const body = code(sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ … $$").split("\n").filter((l) => !l.startsWith("--")).join("\n"))
    assert.doesNotMatch(body, /\bDROP\b/i)
    assert.doesNotMatch(body.replace(/BEFORE (?:INSERT OR )?UPDATE OR DELETE|BEFORE INSERT ON|BEFORE TRUNCATE ON/g, ""), /\bTRUNCATE\b|\bINSERT\b/i)
    assert.doesNotMatch(body.replace(/BEFORE (?:INSERT OR )?UPDATE OR DELETE/g, "").replace(/ON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE)/g, ""), /\bUPDATE\b|\bDELETE\b/i)
    assert.deepEqual([...body.matchAll(/ALTER TYPE "([A-Za-z]+)" ADD VALUE '([A-Z_]+)';/g)].map((m) => [m[1], m[2]]), [["NotificationType", "AUTOMATION"]])
    assert.equal([...body.matchAll(/ALTER TYPE/g)].length, 1)
    for (const m of body.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/ON "([a-z_]+)"\s+(?:DEFERRABLE|FOR EACH)/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("clés composites d'entreprise vers clients, chantiers, devis, salariés ; aucune cascade", () => {
    for (const re of [
      /"opportunities_clientId_companyId_fkey" FOREIGN KEY \("clientId", "companyId"\) REFERENCES "clients"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"opportunities_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"opportunities_quoteId_companyId_fkey" FOREIGN KEY \("quoteId", "companyId"\) REFERENCES "quotes"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"opportunities_ownerEmployeeId_companyId_fkey" FOREIGN KEY \("ownerEmployeeId", "companyId"\) REFERENCES "employees"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"opportunity_events_companyId_opportunityId_fkey" FOREIGN KEY \("companyId", "opportunityId"\) REFERENCES "opportunities"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"automation_rules_taskAssigneeId_companyId_fkey" FOREIGN KEY \("taskAssigneeId", "companyId"\) REFERENCES "employees"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"automation_runs_companyId_ruleId_fkey" FOREIGN KEY \("companyId", "ruleId"\) REFERENCES "automation_rules"\("companyId", "id"\) ON DELETE RESTRICT/,
    ]) assert.match(sql, re)
    assert.match(sql, /CREATE UNIQUE INDEX "automation_runs_companyId_ruleId_eventKey_key" ON "automation_runs"\("companyId", "ruleId", "eventKey"\);/, "une exécution par (société, règle, événement)")
    assert.match(schema, /@@unique\(\[companyId, ruleId, eventKey\]\)/, "schéma aligné sur la migration")
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    const lotE = schema.split("// Lot E Planificator V2 (04/11/2026")[1]
    assert.ok(lotE)
    assert.doesNotMatch(lotE, /onDelete: Cascade/)
  })
  it("CHECK et déclencheurs : étapes closes cohérentes, règle active approuvée, journal et historique immuables", () => {
    assert.match(sql, /"stage" = 'LOST' AND "closedAt" IS NOT NULL AND "probabilityBp" = 0 AND "lostReason" IS NOT NULL/)
    assert.match(sql, /"status" <> 'ACTIVE' OR \("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "activatedAt" IS NOT NULL\)/)
    for (const t of ["opportunity_events", "automation_runs"]) assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON "${t}"\\s+FOR EACH ROW EXECUTE FUNCTION lot_e_history_immutable\\(\\)`), t)
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`BEFORE TRUNCATE ON "${t}"`), t)
    assert.match(sql, /closed opportunity immutable/)
    assert.match(sql, /opportunity consultation must belong to the same company/)
    assert.match(sql, /automation rule configuration immutable/)
    assert.match(sql, /automation rule is not active/)
  })
})

describe("gardes et absence d'envoi externe", () => {
  it("pages et actions passent par leur garde ; aucun companyId lu du client", () => {
    for (const [f, g] of [["src/app/(dashboard)/crm/opportunites/page.tsx", "crmPageAccess"], ["src/app/(dashboard)/crm/opportunites/[id]/page.tsx", "crmPageAccess"], ["src/app/(dashboard)/automatisations/page.tsx", "automationPageAccess"]]) {
      // main : refus rendu sur place (AdminOnlyNotice) avant toute lecture métier, jamais de redirection vers /dashboard (React #310).
      assert.match(read(f), new RegExp(`const ctx = await ${g}\\(\\)\\n[^\\n]*\\n\\s*if \\(!ctx\\) return <AdminOnlyNotice />`), f)
    }
    for (const f of ["src/lib/crm/access.ts", "src/lib/automation/access.ts"]) assert.doesNotMatch(code(read(f)), /redirect\("\/dashboard"\)/, f)
    for (const [f, g] of [["src/lib/actions/crm.actions.ts", "requireCrmAdmin"], ["src/lib/actions/automation.actions.ts", "requireAutomationAdmin"]]) {
      const a = read(f)
      assert.match(a, /^"use server"/, f)
      assert.match(a, new RegExp(`await ${g}\\(\\)`), f)
      assert.doesNotMatch(code(a), /companyId:\s*(?:str|form|optId|reqId)/, f)
    }
  })
  it("automatisations : aucun courrier, aucun appel réseau, aucun service de messagerie importé", () => {
    for (const f of ["src/lib/automation/automation.service.ts", "src/lib/automation/automation.core.ts", "src/lib/actions/automation.actions.ts", "src/app/api/cron/automations/route.ts"]) {
      const c = code(read(f))
      assert.doesNotMatch(c, /\bfetch\(|nodemailer|resend|@\/lib\/email|billing\/mail|sendMail|smtp|https?:\/\//i, f)
    }
  })
  it("exécuteur : verrou partagé de la règle et clé d'événement ; désactivation par verrou exclusif ; tâche planifiée protégée et non planifiée", () => {
    const svc = read("src/lib/automation/automation.service.ts")
    assert.match(svc, /FROM "automation_rules" WHERE "id" = \$\{rule\.id\} AND "companyId" = \$\{rule\.companyId\} FOR SHARE/)
    assert.match(svc, /FROM "automation_rules" WHERE "id" = \$\{id\} AND "companyId" = \$\{ctx\.companyId\} FOR UPDATE/)
    assert.match(svc, /e\.code === "P2002" && .*includes\("eventKey"\)\) return "duplicate"/, "seule la clé d'événement vaut doublon")
    assert.match(svc, /s\.errors\+\+\n\s+continue/, "une occurrence en échec n'interrompt pas la passe")
    const cron = read("src/app/api/cron/automations/route.ts")
    assert.match(cron, /assertCronBearerAuth\(req\)/)
    assert.match(cron, /if \(!isAutomationsEnabled\(\)\) return NextResponse\.json\(\{ code: "FEATURE_DISABLED" \}, \{ status: 404/)
    assert.doesNotMatch(read("vercel.json"), /\/api\/cron\/automations/, "planification non ajoutée par ce lot")
  })
  it("lot E sur main : déclencheur « réserve en retard » retiré (lot D absent) ; Prospection /opportunites intacte", () => {
    assert.doesNotMatch(sql, /RESERVE_OVERDUE/)
    assert.doesNotMatch(schema, /RESERVE_OVERDUE/)
    for (const f of ["src/lib/automation/automation.core.ts", "src/lib/automation/automation.service.ts"]) assert.doesNotMatch(code(read(f)), /RESERVE_OVERDUE|worksiteReserve|reserveOverdue/, f)
    assert.match(read("src/app/(dashboard)/opportunites/page.tsx"), /Prospect|prospect/, "la page /opportunites reste celle de Prospection")
    for (const f of ["src/lib/actions/crm.actions.ts", "src/lib/automation/automation.service.ts", "src/app/(dashboard)/crm/opportunites/page.tsx", "src/app/(dashboard)/crm/opportunites/[id]/page.tsx"])
      assert.doesNotMatch(read(f), /["`]\/opportunites/, `${f} : aucune route CRM sous /opportunites`)
  })
  it("layout : menus conditionnés par drapeau et rôle", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    for (const v of ["crmNavVisible = isCrmEnabled()", "automationNavVisible = isAutomationsEnabled()"]) assert.ok(layout.includes(v), v)
  })
})
