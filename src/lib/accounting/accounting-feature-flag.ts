/**
 * Feature flag du module Comptabilité (Lot 0 — scaffolding).
 *
 * Activer avec ACCOUNTING_MODULE_ENABLED=true (valeur exacte, sensible à la casse).
 *
 * - Lu côté serveur uniquement : aucune variable NEXT_PUBLIC_*, jamais exposée au navigateur.
 * - Désactivé par défaut et fail-closed : variable absente, vide, mal orthographiée
 *   ("TRUE", "1", " true ") ou inconnue ⇒ module désactivé.
 * - Indépendant des autres flags (Acquisition, Booking…) : aucun couplage.
 */
export const ACCOUNTING_MODULE_FLAG_NAME = "ACCOUNTING_MODULE_ENABLED"

export function isAccountingModuleEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env[ACCOUNTING_MODULE_FLAG_NAME] === "true"
}
