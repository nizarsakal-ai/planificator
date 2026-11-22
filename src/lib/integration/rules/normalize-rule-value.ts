/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Normalisation serveur des valeurs de rules (à la persistance admin).
 * value brute : trim → NFC → non vide → borne 256, puis règles par type.
 * Aucune regex libre ; aucun matching runtime.
 */

import {
  INBOUND_SOURCE_BOUNDS,
  INBOUND_SOURCE_RULE_TYPES,
  type InboundSourceRuleType,
} from "@/lib/integration/types/inbound-source-rule-type"
import {
  AdminTextNormalizationError,
  normalizeAdminText,
} from "@/lib/integration/util/normalize-admin-text"

export class RuleValueNormalizationError extends Error {
  readonly code = "RULE_VALUE_INVALID" as const

  constructor(message: string) {
    super(message)
    this.name = "RuleValueNormalizationError"
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Domaine simple : labels alphanum/hyphen, points, TLD ≥ 2. */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

function assertCodePoints(label: string, value: string, max: number): void {
  if (Array.from(value).length > max) {
    throw new RuleValueNormalizationError(
      `${label} dépasse ${max} points de code`
    )
  }
}

/**
 * Produit `normalizedValue` à partir de la valeur brute admin.
 * @throws RuleValueNormalizationError
 */
export function normalizeRuleValue(
  type: InboundSourceRuleType,
  rawValue: string
): string {
  let base: string
  try {
    base = normalizeAdminText(
      rawValue,
      INBOUND_SOURCE_BOUNDS.RULE_VALUE_MAX,
      "value"
    )
  } catch (error) {
    if (error instanceof AdminTextNormalizationError) {
      throw new RuleValueNormalizationError(error.message)
    }
    throw error
  }

  switch (type) {
    case INBOUND_SOURCE_RULE_TYPES.SENDER_EMAIL:
    case INBOUND_SOURCE_RULE_TYPES.RECIPIENT_EMAIL: {
      const v = base.toLowerCase()
      if (!EMAIL_RE.test(v)) {
        throw new RuleValueNormalizationError("email invalide")
      }
      assertCodePoints(
        "normalizedValue",
        v,
        INBOUND_SOURCE_BOUNDS.EMAIL_NORMALIZED_MAX
      )
      return v
    }
    case INBOUND_SOURCE_RULE_TYPES.SENDER_DOMAIN: {
      let v = base.toLowerCase()
      if (v.startsWith("@")) v = v.slice(1)
      v = v.replace(/\.$/, "")
      if (!DOMAIN_RE.test(v)) {
        throw new RuleValueNormalizationError("domaine invalide")
      }
      assertCodePoints(
        "normalizedValue",
        v,
        INBOUND_SOURCE_BOUNDS.DOMAIN_NORMALIZED_MAX
      )
      return v
    }
    case INBOUND_SOURCE_RULE_TYPES.SUBJECT_KEYWORD:
    case INBOUND_SOURCE_RULE_TYPES.BODY_KEYWORD: {
      const v = base.toLowerCase()
      if (v.length === 0) {
        throw new RuleValueNormalizationError("keyword vide après normalisation")
      }
      assertCodePoints(
        "normalizedValue",
        v,
        INBOUND_SOURCE_BOUNDS.KEYWORD_NORMALIZED_MAX
      )
      return v
    }
    default: {
      const _exhaustive: never = type
      throw new RuleValueNormalizationError(`type interdit: ${_exhaustive}`)
    }
  }
}
