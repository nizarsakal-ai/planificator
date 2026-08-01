/**
 * LOT-1C — flags fail-closed.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS,
  PLATFORM_FLAG_NAMES,
} from "@/lib/integration/flags/platform-flag-names"
import {
  getMailShadowRunBudgetMs,
  isCompanyAllowedForMailShadow,
  isExactTrue,
  isMailShadowActiveForCompany,
  isMailShadowEnabled,
  isPlatformFoundationEnabled,
  parseCompanyAllowlist,
  parseMailShadowRunBudgetMs,
} from "@/lib/integration/flags/platform-flags"

describe("platform flags", () => {
  it("isExactTrue uniquement pour true", () => {
    assert.equal(isExactTrue("true"), true)
    assert.equal(isExactTrue("TRUE"), false)
    assert.equal(isExactTrue("1"), false)
    assert.equal(isExactTrue(undefined), false)
  })

  it("allowlist vide = deny", () => {
    assert.equal(parseCompanyAllowlist(undefined).size, 0)
    assert.equal(parseCompanyAllowlist("").size, 0)
    assert.equal(parseCompanyAllowlist("  ").size, 0)
    assert.equal(
      isCompanyAllowedForMailShadow("co1", {
        [PLATFORM_FLAG_NAMES.MAIL_SHADOW_COMPANY_ALLOWLIST]: "",
      }),
      false
    )
  })

  it("allowlist CSV", () => {
    const env = {
      [PLATFORM_FLAG_NAMES.MAIL_SHADOW_COMPANY_ALLOWLIST]: " co1 ,co2 ",
    }
    assert.equal(isCompanyAllowedForMailShadow("co1", env), true)
    assert.equal(isCompanyAllowedForMailShadow("co3", env), false)
  })

  it("activation = foundation ∧ shadow ∧ allowlist", () => {
    const base = {
      [PLATFORM_FLAG_NAMES.FOUNDATION_ENABLED]: "true",
      [PLATFORM_FLAG_NAMES.MAIL_SHADOW_ENABLED]: "true",
      [PLATFORM_FLAG_NAMES.MAIL_SHADOW_COMPANY_ALLOWLIST]: "co1",
    }
    assert.equal(isMailShadowActiveForCompany("co1", base), true)
    assert.equal(
      isMailShadowActiveForCompany("co1", {
        ...base,
        [PLATFORM_FLAG_NAMES.FOUNDATION_ENABLED]: "false",
      }),
      false
    )
    assert.equal(
      isMailShadowActiveForCompany("co1", {
        ...base,
        [PLATFORM_FLAG_NAMES.MAIL_SHADOW_ENABLED]: "yes",
      }),
      false
    )
    assert.equal(isPlatformFoundationEnabled({}), false)
    assert.equal(isMailShadowEnabled({}), false)
  })

  it("budget : défaut et fallback sûr si invalide", () => {
    assert.equal(parseMailShadowRunBudgetMs(undefined), DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS)
    assert.equal(parseMailShadowRunBudgetMs("abc"), DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS)
    assert.equal(parseMailShadowRunBudgetMs("-1"), DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS)
    assert.equal(parseMailShadowRunBudgetMs("500"), 500)
    assert.equal(
      getMailShadowRunBudgetMs({
        [PLATFORM_FLAG_NAMES.MAIL_SHADOW_RUN_BUDGET_MS]: "1500",
      }),
      1500
    )
  })
})
