// COMPTABILITÉ LOT 0 — feature flag ACCOUNTING_MODULE_ENABLED (aucune DB, aucun React).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  ACCOUNTING_MODULE_FLAG_NAME,
  isAccountingModuleEnabled,
} from "@/lib/accounting/accounting-feature-flag"

describe("accounting feature flag", () => {
  it("le nom du flag est ACCOUNTING_MODULE_ENABLED", () => {
    assert.equal(ACCOUNTING_MODULE_FLAG_NAME, "ACCOUNTING_MODULE_ENABLED")
  })

  it("désactivé par défaut : variable absente", () => {
    assert.equal(isAccountingModuleEnabled({}), false)
  })

  it("actif uniquement avec la valeur exacte « true »", () => {
    assert.equal(isAccountingModuleEnabled({ ACCOUNTING_MODULE_ENABLED: "true" }), true)
  })

  it("fail-closed : toute autre valeur désactive le module", () => {
    for (const v of ["", " ", "false", "FALSE", "TRUE", "True", "1", "yes", "on", " true", "true ", "null", "undefined"]) {
      assert.equal(isAccountingModuleEnabled({ ACCOUNTING_MODULE_ENABLED: v }), false, JSON.stringify(v))
    }
  })

  it("indépendant des autres flags (Acquisition, Booking)", () => {
    assert.equal(isAccountingModuleEnabled({ PLANIFICATOR_ACQUISITION_ENABLED: "true" }), false)
    assert.equal(isAccountingModuleEnabled({ BOOKING_GMAIL_SCAN_ENABLED: "true" }), false)
    assert.equal(
      isAccountingModuleEnabled({ ACCOUNTING_MODULE_ENABLED: "true", PLANIFICATOR_ACQUISITION_ENABLED: "false" }),
      true
    )
  })

  it("ne lit que process.env par défaut (pas d'effet de bord)", () => {
    const before = process.env.ACCOUNTING_MODULE_ENABLED
    try {
      delete process.env.ACCOUNTING_MODULE_ENABLED
      assert.equal(isAccountingModuleEnabled(), false)
      process.env.ACCOUNTING_MODULE_ENABLED = "true"
      assert.equal(isAccountingModuleEnabled(), true)
    } finally {
      if (before === undefined) delete process.env.ACCOUNTING_MODULE_ENABLED
      else process.env.ACCOUNTING_MODULE_ENABLED = before
    }
  })
})
