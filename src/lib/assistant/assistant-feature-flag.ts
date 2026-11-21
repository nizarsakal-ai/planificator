// Assistant à règles locales. L'accès exige un drapeau actif et la société pilote configurée côté serveur.
// Une proposition ne devient une action qu'après approbation administrative.
import { matchesLotFPilot, readLotFPilotCompanyId } from "@/lib/lot-f/pilot-target"
type Env = Record<string, string | undefined>
export const ASSISTANT_FLAG_NAME = "ASSISTANT_ENABLED"
export const ASSISTANT_PILOT_FLAG_NAME = "ASSISTANT_PILOT_ENABLED"
export function isAssistantEnabled(env: Env = process.env): boolean {
  return env[ASSISTANT_FLAG_NAME] === "true"
}
/** Drapeau dédié du pilote, strict. */
export function isAssistantPilotEnabled(env: Env = process.env): boolean {
  return env[ASSISTANT_PILOT_FLAG_NAME] === "true"
}
/** Cible de l'assistant (garde et menu) : drapeau pilote ou historique actif ET LOT_F_PILOT_COMPANY_ID valide ; sinon `null`. */
export function readAssistantPilotCompanyId(env: Env = process.env): string | null {
  return readLotFPilotCompanyId(isAssistantPilotEnabled(env) || isAssistantEnabled(env), env)
}
/** Société exactement égale à la cible de l'assistant. Prédicat du menu. */
export function isAssistantEnabledForCompany(companyId: unknown, env: Env = process.env): boolean {
  return matchesLotFPilot(companyId, readAssistantPilotCompanyId(env))
}
