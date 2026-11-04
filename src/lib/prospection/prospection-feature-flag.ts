/**
 * Veille prospection (V1) — drapeaux et configuration, lus côté serveur uniquement.
 *
 * - `PROSPECTION_WATCH_ENABLED=true` (valeur exacte) : module actif. Absent, vide ou autre ⇒ désactivé (fail-closed).
 * - `PROSPECTION_WATCH_COMPANY_IDS` : sociétés pour lesquelles le cron enregistre les opportunités (liste séparée par des virgules).
 * - `PROSPECTION_WATCH_BOAMP_LOOKBACK_DAYS` : fenêtre de collecte BOAMP en jours (défaut 3, borné 1..90). Le recouvrement
 *   entre deux collectes quotidiennes est absorbé par le dédoublonnage.
 * - `DATATOURISME_FLUX_URL` : URL du webservice d'un flux DATAtourisme (contient la clé d'application : secret).
 *   Absente ⇒ adaptateur DATAtourisme désactivé.
 *
 * Aucun appel LLM ni API payante : les sources utilisées sont publiques et gratuites.
 */
export const PROSPECTION_WATCH_FLAG_NAME = "PROSPECTION_WATCH_ENABLED"

type Env = Readonly<Record<string, string | undefined>>

const DEFAULT_BOAMP_LOOKBACK_DAYS = 3
const MAX_BOAMP_LOOKBACK_DAYS = 90

export function isProspectionWatchEnabled(env: Env = process.env): boolean {
  return env[PROSPECTION_WATCH_FLAG_NAME] === "true"
}

export function getProspectionWatchCompanyIds(env: Env = process.env): string[] {
  const raw = env.PROSPECTION_WATCH_COMPANY_IDS ?? ""
  return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))]
}

export function getBoampLookbackDays(env: Env = process.env): number {
  const parsed = Number.parseInt(env.PROSPECTION_WATCH_BOAMP_LOOKBACK_DAYS ?? "", 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BOAMP_LOOKBACK_DAYS
  return Math.min(parsed, MAX_BOAMP_LOOKBACK_DAYS)
}

export function getDatatourismeFluxUrl(env: Env = process.env): string | null {
  const url = env.DATATOURISME_FLUX_URL?.trim()
  if (!url || !url.startsWith("https://")) return null
  return url
}

/** Menu « Opportunités » : drapeau serveur + SUPER_ADMIN + société active. Affichage seulement. */
export function isProspectionNavVisible(input: {
  enabled: boolean
  role: string | null | undefined
  companyId: string | null | undefined
}): boolean {
  return input.enabled === true && input.role === "SUPER_ADMIN" && typeof input.companyId === "string" && input.companyId.trim() !== ""
}
