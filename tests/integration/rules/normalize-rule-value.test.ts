/**
 * LOT-2A — normalisation rule values.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  RuleValueNormalizationError,
  normalizeRuleValue,
} from "@/lib/integration/rules/normalize-rule-value"
import { INBOUND_SOURCE_BOUNDS } from "@/lib/integration/types/inbound-source-rule-type"

describe("normalizeRuleValue", () => {
  it("email : trim NFC lowercase", () => {
    assert.equal(
      normalizeRuleValue("SENDER_EMAIL", "  Alice@Example.COM "),
      "alice@example.com"
    )
  })

  it("domain : retire @ initial", () => {
    assert.equal(
      normalizeRuleValue("SENDER_DOMAIN", "@Mail.Example.COM"),
      "mail.example.com"
    )
  })

  it("keyword : lowercase NFC borné", () => {
    assert.equal(
      normalizeRuleValue("SUBJECT_KEYWORD", "  Devis "),
      "devis"
    )
  })

  it("refuse email invalide et keyword trop long", () => {
    assert.throws(
      () => normalizeRuleValue("SENDER_EMAIL", "not-an-email"),
      RuleValueNormalizationError
    )
    const longKw = "k".repeat(INBOUND_SOURCE_BOUNDS.KEYWORD_NORMALIZED_MAX + 1)
    assert.throws(
      () => normalizeRuleValue("BODY_KEYWORD", longKw),
      RuleValueNormalizationError
    )
  })

  it("refuse domaine suffixe faux / value trop longue", () => {
    assert.throws(
      () => normalizeRuleValue("SENDER_DOMAIN", "not_a_domain"),
      RuleValueNormalizationError
    )
    const long = "a".repeat(INBOUND_SOURCE_BOUNDS.RULE_VALUE_MAX + 1)
    assert.throws(
      () => normalizeRuleValue("SUBJECT_KEYWORD", long),
      RuleValueNormalizationError
    )
  })
})
