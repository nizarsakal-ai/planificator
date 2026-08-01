/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Types de rules MESSAGE V1 (ensemble fermé).
 */

export const INBOUND_SOURCE_RULE_TYPES = {
  SENDER_EMAIL: "SENDER_EMAIL",
  SENDER_DOMAIN: "SENDER_DOMAIN",
  SUBJECT_KEYWORD: "SUBJECT_KEYWORD",
  BODY_KEYWORD: "BODY_KEYWORD",
  RECIPIENT_EMAIL: "RECIPIENT_EMAIL",
} as const

export type InboundSourceRuleType =
  (typeof INBOUND_SOURCE_RULE_TYPES)[keyof typeof INBOUND_SOURCE_RULE_TYPES]

/** Classe IDENTITÉ — obligatoire pour Source enabled. */
export const IDENTITY_RULE_TYPES = [
  INBOUND_SOURCE_RULE_TYPES.SENDER_EMAIL,
  INBOUND_SOURCE_RULE_TYPES.SENDER_DOMAIN,
] as const

export type IdentityRuleType = (typeof IDENTITY_RULE_TYPES)[number]

export function isIdentityRuleType(
  type: InboundSourceRuleType
): type is IdentityRuleType {
  return (
    type === INBOUND_SOURCE_RULE_TYPES.SENDER_EMAIL ||
    type === INBOUND_SOURCE_RULE_TYPES.SENDER_DOMAIN
  )
}

/** Bornes LOT-2A (points de code Unicode). */
export const INBOUND_SOURCE_BOUNDS = {
  DISPLAY_NAME_MAX: 200,
  RULE_VALUE_MAX: 256,
  KEYWORD_NORMALIZED_MAX: 128,
  EMAIL_NORMALIZED_MAX: 254,
  DOMAIN_NORMALIZED_MAX: 253,
  SUBJECT_MAX: 512,
  SOURCES_PER_TENANT_MAX: 200,
  RULES_PER_SOURCE_MAX: 50,
  ACTIVE_RULES_PER_TENANT_MAX: 2000,
} as const
