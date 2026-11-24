// ═══════════════════════════════════════════════════════════════════════════
// 24/11/2026 — Étape 3 (retrait de l'entrée de menu « Propositions », /assistant), PRÉPARÉE, NON ACTIVÉE.
// Reprise de la proposition « Totaux factures Planificator » (4be15d3 : drapeau ASSISTANT_MENU_CONSOLIDATED, câblage du
// menu), ADAPTÉE aux gardes de l'étape 2 : l'entrée n'est retirée QUE si le panneau du copilote affiche l'onglet
// Propositions, c.-à-d. si la garde serveur de la route /assistant (rulesSourceGuard) accepte ET si le copilote est
// visible. Un administrateur autorisé garde donc toujours exactement un accès (menu OU onglet), jamais zéro ni deux.
// Drapeau strictement "true", absent par défaut ⇒ composition du menu strictement identique à l'existant.
// La page /assistant, sa garde, les liens directs et les décisions d'approbation ne changent jamais.
// ═══════════════════════════════════════════════════════════════════════════
import type { CopilotTab } from "@/lib/copilot/copilot-tabs"

type Env = Record<string, string | undefined>

export const ASSISTANT_MENU_CONSOLIDATION_FLAG = "ASSISTANT_MENU_CONSOLIDATED"

export function isAssistantMenuConsolidationEnabled(env: Env = process.env): boolean {
  return env[ASSISTANT_MENU_CONSOLIDATION_FLAG] === "true"
}

/** L'entrée de menu est remplacée seulement si le drapeau est actif ET si l'onglet Propositions est servi (onglets
 *  calculés côté serveur par resolveCopilotTabs avec les gardes distinctes de l'étape 2). */
export function isAssistantMenuReplaced(tabs: readonly CopilotTab[], env: Env = process.env): boolean {
  return isAssistantMenuConsolidationEnabled(env) && tabs.includes("propositions")
}
