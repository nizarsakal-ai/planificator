/**
 * Lot C Planificator V2 : contrôles statiques de la migration et du schéma (additive : aucune colonne ni donnée
 * existante modifiée ; ses clés vers worksites et supplier_invoices ajoutent les déclencheurs RI internes de PostgreSQL
 * sur ces tables référencées), clés composites
 * d'entreprise, CHECK, déclencheurs d'immuabilité), intégration désactivée par défaut et gardes.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const sql = readFileSync("prisma/migrations/20261111120000_v2_lot_c_worksite_budgets/migration.sql", "utf8") // renumérotée après la production (20261110140000), contenu identique
const schema = readFileSync("prisma/schema.prisma", "utf8")
const NEW_TABLES = ["worksite_budgets", "worksite_budget_revisions", "worksite_budget_lines", "supplier_invoice_allocations"]
/** Retire commentaires de bloc et de ligne : les contrôles portent sur le CODE. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

describe("migration du lot C", () => {
  it("additive : aucune suppression ni écriture de données, aucun ALTER, index ni déclencheur explicite sur une table existante (seuls les déclencheurs RI internes des clés vers worksites et supplier_invoices y sont ajoutés par PostgreSQL)", () => {
    const body = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ … $$") // corps des fonctions de déclencheur exclus (RAISE seulement)
    // Clauses d'événement des déclencheurs (« BEFORE UPDATE OR DELETE ON », « AFTER INSERT OR UPDATE ON »…) et actions
    // référentielles neutralisées : ce ne sont pas des écritures de données.
    const instructions = body
      .replace(/\b(?:BEFORE|AFTER) (?:INSERT|UPDATE|DELETE|TRUNCATE)(?: OR (?:INSERT|UPDATE|DELETE|TRUNCATE))* ON\b/g, "EVENEMENT ON")
      .replace(/ON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE)/g, "")
    assert.doesNotMatch(body, /\bDROP\b/i)
    assert.doesNotMatch(instructions, /\bTRUNCATE\b|\bINSERT\b/i)
    assert.doesNotMatch(instructions, /\bUPDATE\b|\bDELETE\b/i)
    for (const m of body.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), `ALTER sur une table existante : ${m[1]}`)
    for (const m of body.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), `index sur une table existante : ${m[1]}`)
    for (const m of body.matchAll(/ON "([a-z_]+)"\s+(?:DEFERRABLE|FOR EACH)/g)) assert.ok(NEW_TABLES.includes(m[1]), `déclencheur sur une table existante : ${m[1]}`)
    assert.doesNotMatch(body, /CREATE (?:OR REPLACE )?EXTENSION/i)
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("chaque table porte companyId ; une version par numéro ; une ligne par nature", () => {
    for (const t of NEW_TABLES) {
      const body = sql.split(`CREATE TABLE "${t}" (`)[1].split(");")[0]
      assert.match(body, /"companyId" TEXT NOT NULL/, t)
    }
    assert.match(sql, /CREATE UNIQUE INDEX "worksite_budgets_worksiteId_companyId_key" ON "worksite_budgets"\("worksiteId", "companyId"\);/)
    assert.match(sql, /CREATE UNIQUE INDEX "worksite_budget_revisions_budgetId_number_key" ON "worksite_budget_revisions"\("budgetId", "number"\);/)
    assert.match(sql, /CREATE UNIQUE INDEX "worksite_budget_lines_revisionId_nature_key" ON "worksite_budget_lines"\("revisionId", "nature"\);/)
  })
  it("clés étrangères composites d'entreprise, jamais en cascade de suppression", () => {
    for (const re of [
      /"worksite_budgets_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"worksite_budget_revisions_companyId_budgetId_fkey" FOREIGN KEY \("companyId", "budgetId"\) REFERENCES "worksite_budgets"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"worksite_budget_lines_companyId_revisionId_fkey" FOREIGN KEY \("companyId", "revisionId"\) REFERENCES "worksite_budget_revisions"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"supplier_invoice_allocations_companyId_supplierInvoiceId_fkey" FOREIGN KEY \("companyId", "supplierInvoiceId"\) REFERENCES "supplier_invoices"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"supplier_invoice_allocations_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\) ON DELETE RESTRICT/,
    ]) assert.match(sql, re)
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    assert.doesNotMatch(sql, /REFERENCES "(?:worksites|worksite_budgets|worksite_budget_revisions|supplier_invoices)"\("id"\)/, "aucune clé simple vers une table d'entreprise")
  })
  it("CHECK : montants positifs bornés, version 1 = initiale, motif obligatoire pour une révision, annulation cohérente", () => {
    assert.match(sql, /"worksite_budget_revisions_values_check" CHECK \(/)
    assert.match(sql, /\(\("kind" = 'INITIAL'\) = \("number" = 1\)\)/)
    assert.match(sql, /"kind" = 'INITIAL' OR \("reason" IS NOT NULL AND length\(btrim\("reason"\)\) >= 3\)/)
    assert.match(sql, /"amountCents" BETWEEN 0 AND 10000000000000/)
    assert.match(sql, /"amountHTCents" BETWEEN 1 AND 10000000000000/)
    assert.match(sql, /\(\("cancelledAt" IS NULL\) = \("cancelledById" IS NULL\)\)/)
  })
  it("immuabilité : versions et lignes ni modifiées ni supprimées ; budget seulement +1 ; imputation seulement annulée ; cohérence différée", () => {
    for (const t of ["worksite_budget_revisions", "worksite_budget_lines"]) {
      assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON "${t}"\\s+FOR EACH ROW EXECUTE FUNCTION worksite_budget_history_immutable\\(\\)`), t)
    }
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`BEFORE TRUNCATE ON "${t}"`), `TRUNCATE interdit : ${t}`)
    assert.match(sql, /NEW\."currentRevision" <> OLD\."currentRevision" \+ 1/)
    assert.match(sql, /BEFORE UPDATE OR DELETE ON "worksite_budgets"/)
    assert.match(sql, /BEFORE UPDATE OR DELETE ON "supplier_invoice_allocations"/)
    assert.match(sql, /OLD\."cancelledAt" IS NOT NULL OR NEW\."cancelledAt" IS NULL/)
    assert.match(sql, /CREATE CONSTRAINT TRIGGER worksite_budget_revisions_consistent AFTER INSERT ON "worksite_budget_revisions"\s+DEFERRABLE INITIALLY DEFERRED/)
    assert.match(sql, /line_total <> NEW\."totalCostCents"/)
    // Revue v1 P1 : aucune ligne ajoutée à une version qui n'a pas été créée par la transaction courante.
    assert.match(sql, /CREATE TRIGGER worksite_budget_lines_insert_guard BEFORE INSERT ON "worksite_budget_lines"\s+FOR EACH ROW EXECUTE FUNCTION worksite_budget_line_insert_guard\(\)/)
    assert.match(sql, /SELECT xmin::text INTO revision_xmin FROM "worksite_budget_revisions" WHERE "id" = NEW\."revisionId" AND "companyId" = NEW\."companyId"/)
    assert.match(sql, /revision_xmin <> \(pg_current_xact_id\(\)::text::numeric % 4294967296\)::text/)
    // Revue C-R1 : la version courante d'un budget doit être enregistrée (contrôle différé à la validation).
    assert.match(sql, /CREATE CONSTRAINT TRIGGER worksite_budgets_current_recorded AFTER INSERT OR UPDATE ON "worksite_budgets"\s+DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION worksite_budget_current_recorded\(\)/)
    assert.match(sql, /NEW\."currentRevision" <> 0 AND NOT EXISTS \(/)
  })
  it("schéma : modèles déclarés, montants en BigInt, relations du lot sans cascade", () => {
    for (const m of ["WorksiteBudget", "WorksiteBudgetRevision", "WorksiteBudgetLine", "SupplierInvoiceAllocation"]) assert.match(schema, new RegExp(`^model ${m} \\{`, "m"), m)
    const lotC = schema.split("// Lot C Planificator V2 (04/11/2026)")[1]
    assert.ok(lotC)
    assert.doesNotMatch(lotC, /onDelete: Cascade/)
    assert.doesNotMatch(lotC, /Cents\s+(?:Int|Decimal|Float)/, "montants du lot C en BigInt")
  })
})

describe("intégration désactivée par défaut et gardes", () => {
  it("pages, export et actions passent par la garde ; aucun identifiant d'entreprise lu du client", () => {
    for (const f of ["src/app/(dashboard)/budgets/page.tsx", "src/app/(dashboard)/budgets/[worksiteId]/page.tsx"]) {
      const page = readFileSync(f, "utf8")
      assert.match(page, /const ctx = await budgetPageAccess\(\)\n[^\n]*\n\s+if \(!ctx\) return <AdminOnlyNotice \/>/, f)
      assert.doesNotMatch(code(page), /redirect\(/, `${f} : aucune redirection pendant le rendu`)
    }
    const route = code(readFileSync("src/app/(dashboard)/budgets/export/route.ts", "utf8"))
    assert.match(route, /const access = await resolveBudgetAccess\(\)\n\s+if \(!access\.ok\) return none\(budgetDenialStatus\(access\.reason\)\)/)
    assert.match(route, /const companyId = access\.context\.companyId/)
    const actions = readFileSync("src/lib/actions/budget.actions.ts", "utf8")
    assert.match(actions, /^"use server"/)
    assert.match(actions, /const ctx = await requireBudgetAdmin\(\)/)
    assert.doesNotMatch(code(actions), /companyId/)
  })
  it("verrous de ligne bornés à l'entreprise (budget pour réviser, facture fournisseur pour imputer)", () => {
    const svc = readFileSync("src/lib/budget/budget.service.ts", "utf8")
    const locks = [...svc.matchAll(/\$queryRaw[^`]*`([^`]*)`/g)].map((m) => m[1])
    assert.equal(locks.length, 2)
    for (const l of locks) {
      assert.match(l, /FOR UPDATE/)
      assert.match(l, /"companyId" = \$\{ctx\.companyId\}/)
    }
    assert.match(svc, /updateMany\(\{ where: \{ id: budgetId, companyId: ctx\.companyId, currentRevision: from \}/, "avance conditionnelle de la version")
  })
  it("lectures bornées par companyId : chaque requête Prisma de queries.ts filtre l'entreprise", () => {
    const q = code(readFileSync("src/lib/budget/queries.ts", "utf8"))
    for (const m of q.matchAll(/tx\.(\w+)\.(findMany|findFirst|groupBy|aggregate)\(\{\s*where: \{ ([^}]*)/g)) {
      assert.match(m[3], /companyId|id: \{ in: authorIds/, `${m[1]}.${m[2]} non borné : ${m[3]}`)
    }
  })
  it("drapeau absent ⇒ 404 : garde des pages et drapeau contrôlé avant la session ; menu conditionné", () => {
    const access = readFileSync("src/lib/budget/access.ts", "utf8")
    assert.match(access, /if \(decision === "NOT_FOUND"\) notFound\(\)/)
    assert.match(access, /if \(decision === "LOGIN"\) redirect\("\/login"\)/)
    assert.doesNotMatch(code(access), /redirect\("\/dashboard"\)/, "refus rendu sur place, plus de redirection vers /dashboard")
    assert.match(access, /if \(!isWorksiteBudgetEnabled\(\)\) return \{ ok: false, reason: "MODULE_DISABLED" \}/)
    const layout = readFileSync("src/app/(dashboard)/layout.tsx", "utf8")
    assert.match(layout, /const budgetNavVisible = isWorksiteBudgetEnabled\(\) && \(role === "ADMIN" \|\| role === "SUPER_ADMIN"\) && !!companyId/)
  })
})
