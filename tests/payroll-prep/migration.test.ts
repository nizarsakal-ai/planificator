/**
 * Lot H Planificator V2 : contrôles statiques (migration additive, CHECK et déclencheurs, gardes) et périmètre
 * (aucun calcul de paie, aucun dépôt DSN, rapport de paie existant inchangé par le module).
 * Portage sur 90ae644 (19/11/2026) : migration renumérotée APRÈS la dernière migration de main, SQL H corrigé (IS NOT NULL
 * explicites) identique à l'octet ; gardes de page par refus rendu sur place (prepayPageAccess + AdminOnlyNotice).
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const MIGRATION_DIR = "20261119140000_v2_lot_h_payroll_prep"
const sqlBytes = readFileSync(`prisma/migrations/${MIGRATION_DIR}/migration.sql`)
const sql = sqlBytes.toString("utf8")
const schema = readFileSync("prisma/schema.prisma", "utf8")
const NEW_TABLES = ["payroll_periods", "payroll_manual_variables"]
const MARKER = "// Lot H Planificator V2 (05/11/2026"
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const read = (f: string) => readFileSync(f, "utf8")

describe("migration du lot H", () => {
  it("SQL H corrigé identique à l'octet ; seule migration H ; horodatée après toutes les migrations existantes", () => {
    assert.equal(createHash("sha256").update(sqlBytes).digest("hex"), "6bf15b8f9a0b10657da801fdfa57e4baab45475f581afb2fde3a087bd0115ece")
    const dirs = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort()
    assert.deepEqual(dirs.filter((d) => d.includes("lot_h")), [MIGRATION_DIR])
    // Intégration FGHI : H reste après F, G et toutes les migrations de la base ; seule I la suit.
    // Seul le lot I suit H ; les migrations ultérieures hors lots (photos, espace PDF du Studio…) ne comptent pas.
    assert.deepEqual(dirs.filter((d) => d > MIGRATION_DIR && /_v2_lot_/.test(d)), ["20261119150000_v2_lot_i_marketing_shop"], "seule I après H")
    assert.ok(dirs.includes("20261117120000_vehicle_tour_auto_km"), "dernière migration de main 90ae644 présente")
  })
  it("additive : aucun objet existant modifié, aucune donnée lue ni écrite", () => {
    const body = code(sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ … $$").split("\n").filter((l) => !l.startsWith("--")).join("\n"))
    assert.doesNotMatch(body, /\bDROP\b|ALTER TYPE/i)
    assert.doesNotMatch(body.replace(/BEFORE (?:INSERT OR )?UPDATE OR DELETE|BEFORE INSERT ON|BEFORE TRUNCATE ON/g, ""), /\bTRUNCATE\b|\bINSERT\b/i)
    assert.doesNotMatch(body.replace(/BEFORE (?:INSERT OR )?UPDATE OR DELETE/g, "").replace(/ON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE)/g, ""), /\bUPDATE\b|\bDELETE\b/i)
    for (const m of body.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/ON "([a-z_]+)"\s+(?:DEFERRABLE|FOR EACH)/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("une période par mois et par entreprise ; clés composites ; aucune cascade ; aucune table de paie ou de DSN", () => {
    assert.match(sql, /CREATE UNIQUE INDEX "payroll_periods_companyId_year_month_key" ON "payroll_periods"\("companyId", "year", "month"\);/)
    assert.match(sql, /"payroll_manual_variables_companyId_periodId_fkey" FOREIGN KEY \("companyId", "periodId"\) REFERENCES "payroll_periods"\("companyId", "id"\) ON DELETE RESTRICT/)
    assert.match(sql, /"payroll_manual_variables_employeeId_companyId_fkey" FOREIGN KEY \("employeeId", "companyId"\) REFERENCES "employees"\("id", "companyId"\) ON DELETE RESTRICT/)
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    assert.ok(schema.includes(MARKER), "marqueur du lot H présent")
    const lotH = schema.split(MARKER)[1]
    assert.doesNotMatch(lotH, /onDelete: Cascade/)
    assert.doesNotMatch(lotH.replace(/\/\/.*$/gm, ""), /cotisation|contribution|salaireBrut|grossSalary|netSalary|payslip|Dsn|dsn/i, "aucun modèle de paie ni de DSN")
  })
  it("CHECK et déclencheurs : période clôturée immuable et empreinte ; variables sur période ouverte seulement", () => {
    assert.match(sql, /"status" = 'CLOSED' AND "snapshot" IS NOT NULL AND jsonb_typeof\("snapshot"\) = 'object'\n\s+AND "snapshotSha256" IS NOT NULL AND "snapshotSha256" ~ '\^\[0-9a-f\]\{64\}\$'/, "IS NOT NULL explicites : un NULL ne passe pas le CHECK")
    for (const m of ["payroll period cannot be deleted", "payroll period must start open", "closed payroll period immutable", "payroll period identity immutable", "payroll variable immutable", "payroll period is closed"]) assert.ok(sql.includes(m), m)
    assert.match(sql, /SELECT p\."status"::text INTO p_status FROM "payroll_periods" p WHERE p\."id" = p_period AND p\."companyId" = p_company FOR SHARE;/)
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`BEFORE TRUNCATE ON "${t}"`), t)
  })
})

describe("gardes et périmètre", () => {
  it("pages, actions et export passent par leur garde ; aucun companyId lu du client", () => {
    for (const f of ["src/app/(dashboard)/pre-paie/page.tsx", "src/app/(dashboard)/pre-paie/[periodId]/page.tsx"]) {
      const c = code(read(f))
      assert.match(c, /const ctx = await prepayPageAccess\(\)\n\s+if \(!ctx\) return <AdminOnlyNotice \/>\n/, `${f} : refus rendu sur place, première instruction après la garde`)
      const garde = c.indexOf("if (!ctx) return <AdminOnlyNotice />")
      for (const lecture of ["prisma.employee", "listPeriods(", "getPeriodView(", "await params", "await searchParams"]) {
        const at = c.indexOf(lecture)
        if (at >= 0) assert.ok(at > garde, `${f} : ${lecture} après la garde`)
      }
      assert.doesNotMatch(c, /requirePrepayPage|redirect\(/, `${f} : aucune redirection vers /dashboard`)
    }
    const access = read("src/lib/payroll-prep/access.ts")
    assert.ok(access.includes("const decision = pageDecision(r.reason)"), "décision de page partagée avec les lots A et B")
    assert.doesNotMatch(code(access), /redirect\("\/dashboard"\)/)
    const ex = read("src/app/(dashboard)/pre-paie/[periodId]/export/route.ts")
    assert.match(ex, /const access = await resolvePrepayAccess\(\)\n\s+if \(!access\.ok\) return none\(prepayDenialStatus\(access\.reason\)\)/)
    assert.match(ex, /if \(!v\.intact\) \{[\s\S]*?return none\(409\)/)
    const a = read("src/lib/actions/payroll-prep.actions.ts")
    assert.match(a, /^"use server"/)
    assert.match(a, /await requirePrepayAdmin\(\)/)
    assert.doesNotMatch(code(a), /companyId:\s*(?:str|form|reqId)/)
  })
  it("aucun calcul de paie : ni salaire, ni cotisation, ni bulletin dans le module ; rapport de paie existant non importé", () => {
    for (const f of readdirSync("src/lib/payroll-prep").filter((x) => x !== "dsn-model.ts")) {
      const c = code(read(`src/lib/payroll-prep/${f}`))
      assert.doesNotMatch(c, /cotisation|taux de|salaire brut|net à payer|bulletin\(|grossSalary|netSalary/i, f)
      assert.doesNotMatch(c, /api\/pdf\/paie/, f)
    }
    assert.match(read("src/lib/payroll-prep/prepay-feature-flag.ts"), /ne calcule ni salaire,\n\/\/ ni cotisation/)
    assert.ok(read("src/app/(dashboard)/layout.tsx").includes(`const payrollPrepNavVisible = isPayrollPrepEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`))
  })
})
