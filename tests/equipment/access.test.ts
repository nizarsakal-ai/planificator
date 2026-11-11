/** Lot B Planificator V2 : garde d'accès du module matériel (drapeau distinct du lot A, même règle de rôle). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveEquipmentAccessCore } from "@/lib/equipment/access"
import { pageDecision } from "@/lib/stock/access"
import { isEquipmentRentalEnabled } from "@/lib/equipment/equipment-feature-flag"

describe("garde d'accès matériel et location", () => {
  it("drapeau absent ou différent de \"true\" ⇒ module inexistant ; indépendant du drapeau du lot A", () => {
    for (const v of [undefined, "", "TRUE", "1", "yes", "false"]) assert.equal(isEquipmentRentalEnabled({ EQUIPMENT_RENTAL_ENABLED: v }), false, String(v))
    assert.equal(isEquipmentRentalEnabled({ EQUIPMENT_RENTAL_ENABLED: "true" }), true)
    assert.equal(isEquipmentRentalEnabled({ STOCK_PURCHASING_ENABLED: "true" }), false)
    assert.deepEqual(resolveEquipmentAccessCore(false, { user: { id: "u", role: "ADMIN", companyId: "c" } }), { ok: false, reason: "MODULE_DISABLED" })
  })
  it("ADMIN et SUPER_ADMIN avec société seulement ; companyId tiré de la session", () => {
    assert.deepEqual(resolveEquipmentAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: "c" } }), { ok: true, context: { userId: "u", companyId: "c", role: "ADMIN" } })
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT", null]) assert.deepEqual(resolveEquipmentAccessCore(true, { user: { id: "u", role, companyId: "c" } }), { ok: false, reason: "FORBIDDEN" }, String(role))
    assert.deepEqual(resolveEquipmentAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: "" } }), { ok: false, reason: "NO_COMPANY" })
    assert.deepEqual(resolveEquipmentAccessCore(true, null), { ok: false, reason: "UNAUTHENTICATED" })
  })
  it("décision de page matériel : 404 si désactivé, refus rendu sur place pour rôle ou société non habilités", () => {
    for (const role of ["TEAM_LEADER", "EMPLOYEE", "CLIENT"]) {
      const r = resolveEquipmentAccessCore(true, { user: { id: "u", role, companyId: "c" } })
      assert.ok(!r.ok && pageDecision(r.reason) === "DENIED", role)
    }
    const sansSociete = resolveEquipmentAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: "" } })
    assert.ok(!sansSociete.ok && pageDecision(sansSociete.reason) === "DENIED")
    const desactive = resolveEquipmentAccessCore(false, { user: { id: "u", role: "ADMIN", companyId: "c" } })
    assert.ok(!desactive.ok && pageDecision(desactive.reason) === "NOT_FOUND")
  })
})
