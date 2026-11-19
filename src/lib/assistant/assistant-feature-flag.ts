// Lot F Planificator V2 : assistant. Désactivé par défaut : sans ASSISTANT_ENABLED="true", ni page ni action. Même
// activé, l'assistant ne fait QUE proposer ; chaque action exige l'approbation d'un administrateur. Aucun fournisseur
// d'IA externe n'est branché (voir providers.ts) : ce drapeau n'en active aucun.
type Env = Record<string, string | undefined>
export const ASSISTANT_FLAG_NAME = "ASSISTANT_ENABLED"
export function isAssistantEnabled(env: Env = process.env): boolean {
  return env[ASSISTANT_FLAG_NAME] === "true"
}
