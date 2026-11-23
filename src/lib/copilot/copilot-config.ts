// IA-1 : copilote Planificator, en lecture seule. Désactivé par défaut : il faut COPILOT_ENABLED="true",
// COPILOT_COMPANY_ID égal à la société ACTIVE de la session, ANTHROPIC_API_KEY et une limite quotidienne valide.
// Sans l'un d'eux : ni bouton, ni point d'accès (404). Lecture côté serveur seulement.
type Env = Record<string, string | undefined>

export const COPILOT_MODEL = "claude-haiku-5-5"
export const COPILOT_DEFAULT_DAILY_LIMIT = 50
export const COPILOT_MAX_DAILY_LIMIT = 500

export interface CopilotConfig { apiKey: string; dailyLimit: number }

function readDailyLimit(env: Env): number | null {
  const raw = env.COPILOT_DAILY_LIMIT?.trim()
  if (!raw) return COPILOT_DEFAULT_DAILY_LIMIT
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= COPILOT_MAX_DAILY_LIMIT ? n : null
}

/** Société exactement égale à la cible du copilote, drapeau actif. Prédicat d'affichage (aucun secret lu). */
export function isCopilotEnabledForCompany(companyId: unknown, env: Env = process.env): boolean {
  const target = env.COPILOT_COMPANY_ID?.trim()
  return env.COPILOT_ENABLED === "true" && !!target && typeof companyId === "string" && companyId === target
}

/** Configuration complète, ou `null` si le copilote n'est pas utilisable pour cette société. */
export function copilotConfig(companyId: unknown, env: Env = process.env): CopilotConfig | null {
  if (!isCopilotEnabledForCompany(companyId, env)) return null
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  const dailyLimit = readDailyLimit(env)
  if (!apiKey || dailyLimit === null) return null
  return { apiKey, dailyLimit }
}

/** Rôles autorisés en IA-1 : l'administration de la société. Les autres rôles viendront en IA-6. */
export function isCopilotRole(role: unknown): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN"
}
