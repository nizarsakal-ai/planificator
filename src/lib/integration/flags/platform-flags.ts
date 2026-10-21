/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Flags fail-closed — activation strictement `=== "true"`.
 */

import {
  DEFAULT_AGENT_GATEWAY_RPM,
  DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS,
  MAX_AGENT_GATEWAY_RPM,
  MAX_MAIL_SHADOW_RUN_BUDGET_MS,
  MIN_AGENT_GATEWAY_RPM,
  PLATFORM_FLAG_NAMES,
} from "@/lib/integration/flags/platform-flag-names"

export type PlatformFlagEnv = NodeJS.ProcessEnv | Record<string, string | undefined>

function readRaw(env: PlatformFlagEnv, name: string): string | undefined {
  const v = env[name]
  return typeof v === "string" ? v : undefined
}

/** Strictement la chaîne "true". */
export function isExactTrue(value: string | undefined): boolean {
  return value === "true"
}

/**
 * Parse allowlist CSV d’ids opaques.
 * Vide / whitespace-only / invalide → Set vide (fail-closed).
 */
export function parseCompanyAllowlist(raw: string | undefined): Set<string> {
  if (raw === undefined || raw.trim().length === 0) return new Set()
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return new Set(ids)
}

/**
 * Budget run ms : entier positif borné ; invalide → défaut sûr.
 */
export function parseMailShadowRunBudgetMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS
  }
  return Math.min(n, MAX_MAIL_SHADOW_RUN_BUDGET_MS)
}

export function isPlatformFoundationEnabled(env: PlatformFlagEnv = process.env): boolean {
  return isExactTrue(readRaw(env, PLATFORM_FLAG_NAMES.FOUNDATION_ENABLED))
}

export function isMailShadowEnabled(env: PlatformFlagEnv = process.env): boolean {
  return isExactTrue(readRaw(env, PLATFORM_FLAG_NAMES.MAIL_SHADOW_ENABLED))
}

export function isCompanyAllowedForMailShadow(
  companyId: string,
  env: PlatformFlagEnv = process.env
): boolean {
  if (!companyId) return false
  const allow = parseCompanyAllowlist(
    readRaw(env, PLATFORM_FLAG_NAMES.MAIL_SHADOW_COMPANY_ALLOWLIST)
  )
  return allow.has(companyId)
}

/**
 * Fail-closed : foundation ∧ shadow ∧ allowlist.
 * (Connection / redaction API = autres gates ; smoke runtime interdit.)
 */
export function isMailShadowActiveForCompany(
  companyId: string,
  env: PlatformFlagEnv = process.env
): boolean {
  return (
    isPlatformFoundationEnabled(env) &&
    isMailShadowEnabled(env) &&
    isCompanyAllowedForMailShadow(companyId, env)
  )
}

export function getMailShadowRunBudgetMs(env: PlatformFlagEnv = process.env): number {
  return parseMailShadowRunBudgetMs(
    readRaw(env, PLATFORM_FLAG_NAMES.MAIL_SHADOW_RUN_BUDGET_MS)
  )
}

// ─── PLAN-AGENT-GATEWAY-001 — LOT-1A ────────────────────────────────────────
// Même discipline que mail-shadow : activation strictement `=== "true"`, parse défensif.

export function isAgentGatewayEnabled(env: PlatformFlagEnv = process.env): boolean {
  return isExactTrue(readRaw(env, PLATFORM_FLAG_NAMES.AGENT_GATEWAY_ENABLED))
}

export function isCompanyAllowedForAgentGateway(
  companyId: string,
  env: PlatformFlagEnv = process.env
): boolean {
  if (!companyId) return false
  const allow = parseCompanyAllowlist(
    readRaw(env, PLATFORM_FLAG_NAMES.AGENT_GATEWAY_COMPANY_ALLOWLIST)
  )
  return allow.has(companyId)
}

/**
 * Requêtes/min par principal : entier dans [MIN, MAX] ; absent ou invalide → défaut sûr.
 * Au-dessus de MAX → MAX ; en dessous de MIN (0, négatif) → défaut (jamais 0 : un quota nul
 * serait un déni de service silencieux, pas un réglage).
 */
export function parseAgentGatewayRpm(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_AGENT_GATEWAY_RPM
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_AGENT_GATEWAY_RPM) {
    return DEFAULT_AGENT_GATEWAY_RPM
  }
  return Math.min(n, MAX_AGENT_GATEWAY_RPM)
}

export function getAgentGatewayRpm(env: PlatformFlagEnv = process.env): number {
  return parseAgentGatewayRpm(readRaw(env, PLATFORM_FLAG_NAMES.AGENT_GATEWAY_RPM))
}

/**
 * Fail-closed : flag structurel ∧ allowlist. Les autres gardes (contrôle en base,
 * principal, scopes) relèvent de l'enveloppe transactionnelle (lots suivants).
 */
export function isAgentGatewayActiveForCompany(
  companyId: string,
  env: PlatformFlagEnv = process.env
): boolean {
  return isAgentGatewayEnabled(env) && isCompanyAllowedForAgentGateway(companyId, env)
}
