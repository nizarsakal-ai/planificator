/** Lot C Planificator V2 : garde d'accès du module budgets et marges (drapeau distinct des lots A et B, même règle de rôle). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { budgetDenialStatus, budgetPageDecision, resolveBudgetAccessCore } from "@/lib/budget/access"
import { isWorksiteBudgetEnabled } from "@/lib/budget/budget-feature-flag"

describe("garde d'accès budgets et marges", () => {
  it("drapeau absent ou différent de \"true\" ⇒ module inexistant ; indépendant des drapeaux des lots A et B", () => {
    for (const v of [undefined, "", "TRUE", "1", "yes", "false"]) assert.equal(isWorksiteBudgetEnabled({ WORKSITE_BUDGET_ENABLED: v }), false, String(v))
    assert.equal(isWorksiteBudgetEnabled({ WORKSITE_BUDGET_ENABLED: "true" }), true)
    assert.equal(isWorksiteBudgetEnabled({ STOCK_PURCHASING_ENABLED: "true", EQUIPMENT_RENTAL_ENABLED: "true" }), false)
    assert.deepEqual(resolveBudgetAccessCore(false, { user: { id: "u", role: "ADMIN", companyId: "c" } }), { ok: false, reason: "MODULE_DISABLED" })
  })
  it("ADMIN et SUPER_ADMIN avec société seulement ; companyId tiré de la session", () => {
    assert.deepEqual(resolveBudgetAccessCore(true, { user: { id: "u", role: "SUPER_ADMIN", companyId: "c" } }), { ok: true, context: { userId: "u", companyId: "c", role: "SUPER_ADMIN" } })
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", null]) assert.deepEqual(resolveBudgetAccessCore(true, { user: { id: "u", role, companyId: "c" } }), { ok: false, reason: "FORBIDDEN" }, String(role))
    assert.deepEqual(resolveBudgetAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: " " } }), { ok: false, reason: "NO_COMPANY" })
    assert.deepEqual(resolveBudgetAccessCore(true, null), { ok: false, reason: "UNAUTHENTICATED" })
  })
  it("export : désactivé ⇒ 404 (le module n'existe pas), non connecté ⇒ 401, autre refus ⇒ 403", () => {
    assert.equal(budgetDenialStatus("MODULE_DISABLED"), 404)
    assert.equal(budgetDenialStatus("UNAUTHENTICATED"), 401)
    assert.equal(budgetDenialStatus("FORBIDDEN"), 403)
    assert.equal(budgetDenialStatus("NO_COMPANY"), 403)
  })
  it("pages : désactivé ⇒ 404, non connecté ⇒ connexion, rôle ou société non habilités ⇒ refus rendu sur place (même règle que A et B)", () => {
    assert.equal(budgetPageDecision("MODULE_DISABLED"), "NOT_FOUND")
    assert.equal(budgetPageDecision("UNAUTHENTICATED"), "LOGIN")
    assert.equal(budgetPageDecision("FORBIDDEN"), "DENIED")
    assert.equal(budgetPageDecision("NO_COMPANY"), "DENIED")
  })
})
