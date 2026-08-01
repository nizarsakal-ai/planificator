/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Noms d’env figés (fail-closed).
 */

export const PLATFORM_FLAG_NAMES = {
  FOUNDATION_ENABLED: "INTEGRATION_PLATFORM_FOUNDATION_ENABLED",
  MAIL_SHADOW_ENABLED: "INTEGRATION_MAIL_SHADOW_ENABLED",
  MAIL_SHADOW_COMPANY_ALLOWLIST: "INTEGRATION_MAIL_SHADOW_COMPANY_ALLOWLIST",
  /** Budget global shadow par run (ms). */
  MAIL_SHADOW_RUN_BUDGET_MS: "INTEGRATION_MAIL_SHADOW_RUN_BUDGET_MS",
} as const

/** Défaut documenté — budget global du run shadow. */
export const DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS = 2000

/** Borne haute défensive. */
export const MAX_MAIL_SHADOW_RUN_BUDGET_MS = 60_000

/** connectorType opaque figé LOT-1C (≠ secretBackend). */
export const MAIL_SHADOW_CONNECTOR_TYPE = "platform.mail.legacy" as const
