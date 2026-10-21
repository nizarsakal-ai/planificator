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
  /** PLAN-AGENT-GATEWAY-001 — LOT-1A. Kill-switch structurel de la passerelle agent (fail-closed). */
  AGENT_GATEWAY_ENABLED: "INTEGRATION_AGENT_GATEWAY_ENABLED",
  /** PLAN-AGENT-GATEWAY-001 — LOT-1A. Allowlist CSV d'ids d'entreprise (vide ⇒ aucune). */
  AGENT_GATEWAY_COMPANY_ALLOWLIST: "INTEGRATION_AGENT_GATEWAY_COMPANY_ALLOWLIST",
  /** PLAN-AGENT-GATEWAY-001 — LOT-1A. Requêtes/min par principal (borné 1–1000, défaut 120). */
  AGENT_GATEWAY_RPM: "INTEGRATION_AGENT_GATEWAY_RPM",
} as const

/** Défaut documenté — budget global du run shadow. */
export const DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS = 2000

/** Borne haute défensive. */
export const MAX_MAIL_SHADOW_RUN_BUDGET_MS = 60_000

/** connectorType opaque figé LOT-1C (≠ secretBackend). */
export const MAIL_SHADOW_CONNECTOR_TYPE = "platform.mail.legacy" as const

// ─── PLAN-AGENT-GATEWAY-001 — LOT-1A ────────────────────────────────────────

/** Débit par principal (SPEC §9, décision D1a). */
export const DEFAULT_AGENT_GATEWAY_RPM = 120
export const MIN_AGENT_GATEWAY_RPM = 1
export const MAX_AGENT_GATEWAY_RPM = 1000

/** Limites anonymes (SPEC §9, décision D6a) — constantes, non surchargeables par l'env. */
export const AGENT_ANON_RPM_GLOBAL = 300
export const AGENT_ANON_RPM_PER_IP = 30

/** Prérequis PostgreSQL ≥ 17 (SPEC §5.4, décision D7) — plancher, non surchargeable vers le bas. */
export const AGENT_GATEWAY_PG_MIN_VERSION_NUM = 170000

/** Secrets de la passerelle (SPEC §4.5) — noms figés ; lus par src/lib/agent-gateway/secrets.ts. */
export const AGENT_GATEWAY_SECRET_NAMES = {
  DIGEST_SECRET: "INTEGRATION_AGENT_GATEWAY_DIGEST_SECRET",
  CURSOR_SECRET: "INTEGRATION_AGENT_GATEWAY_CURSOR_SECRET",
} as const
