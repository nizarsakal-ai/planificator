/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Flags fail-closed — activation strictement `=== "true"`.
 */

import {
  DEFAULT_MAIL_SHADOW_RUN_BUDGET_MS,
  MAX_MAIL_SHADOW_RUN_BUDGET_MS,
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
