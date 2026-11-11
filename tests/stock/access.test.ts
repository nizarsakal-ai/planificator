/** Lot A Planificator V2 : garde d'accès du module (drapeau → session → rôle → société) et drapeau désactivé par défaut. */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { pageDecision, resolveStockAccessCore } from "@/lib/stock/access"
import { isStockPurchasingEnabled } from "@/lib/stock/stock-feature-flag"

describe("garde d'accès stocks et achats", () => {
  it("drapeau absent ou différent de \"true\" ⇒ module inexistant", () => {
    for (const v of [undefined, "", "TRUE", "1", "yes", "false"]) assert.equal(isStockPurchasingEnabled({ STOCK_PURCHASING_ENABLED: v }), false, String(v))
    assert.equal(isStockPurchasingEnabled({ STOCK_PURCHASING_ENABLED: "true" }), true)
    assert.deepEqual(resolveStockAccessCore(false, { user: { id: "u", role: "ADMIN", companyId: "c" } }), { ok: false, reason: "MODULE_DISABLED" })
  })
  it("ADMIN et SUPER_ADMIN avec société seulement ; companyId tiré de la session", () => {
    assert.deepEqual(resolveStockAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: "c" } }), { ok: true, context: { userId: "u", companyId: "c", role: "ADMIN" } })
    assert.deepEqual(resolveStockAccessCore(true, { user: { id: "u", role: "SUPER_ADMIN", companyId: " c " } }), { ok: true, context: { userId: "u", companyId: "c", role: "SUPER_ADMIN" } })
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", null]) assert.deepEqual(resolveStockAccessCore(true, { user: { id: "u", role, companyId: "c" } }), { ok: false, reason: "FORBIDDEN" }, String(role))
    assert.deepEqual(resolveStockAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: null } }), { ok: false, reason: "NO_COMPANY" })
    assert.deepEqual(resolveStockAccessCore(true, null), { ok: false, reason: "UNAUTHENTICATED" })
    assert.deepEqual(resolveStockAccessCore(true, { user: { id: " ", role: "ADMIN", companyId: "c" } }), { ok: false, reason: "UNAUTHENTICATED" })
  })
  it("décision de page : 404 si désactivé, /login si non connecté, refus rendu sur place pour rôle ou société non habilités", () => {
    assert.equal(pageDecision("MODULE_DISABLED"), "NOT_FOUND")
    assert.equal(pageDecision("UNAUTHENTICATED"), "LOGIN")
    assert.equal(pageDecision("FORBIDDEN"), "DENIED")
    assert.equal(pageDecision("NO_COMPANY"), "DENIED")
    // Chaîne complète pour chaque rôle refusé : jamais de 404 (le module existe) ni de redirection.
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
      const r = resolveStockAccessCore(true, { user: { id: "u", role, companyId: "c" } })
      assert.ok(!r.ok && pageDecision(r.reason) === "DENIED", role)
    }
  })
})
