/**
 * Drapeaux serveur de la facturation complète (Lot C). Lus UNIQUEMENT ici, jamais exposés au navigateur
 * (aucune variable NEXT_PUBLIC_*). Fail-closed : seule la valeur exacte "true" active une fonctionnalité.
 *
 * - BILLING_COMPLETE_ENABLED : devis complets, factures/paiements, acomptes, avoirs partiels, écrans C5.
 *   OFF ⇒ comportement de production actuel strictement identique (pages 404, actions refusées, menu inchangé).
 * - BILLING_MAIL_ENABLED : envoi réel des courriers (Resend). OFF ⇒ courriers journalisés en SIMULATED.
 * - BILLING_REMINDERS_ENABLED : exécution des jobs de relance (devis J+3/7/15, factures J+30/45/60). OFF ⇒ 404.
 * - BILLING_OCR_ENABLED : appel réel de l'API Claude pour l'OCR des factures fournisseurs. OFF ⇒ extraction refusée (saisie manuelle).
 * - ACCOUNTING_AUTO_POSTING_ENABLED : génération automatique des écritures à l'émission/paiement (sinon bouton manuel, idempotent).
 */
export const BILLING_COMPLETE_FLAG_NAME = "BILLING_COMPLETE_ENABLED"
export const BILLING_MAIL_FLAG_NAME = "BILLING_MAIL_ENABLED"
export const BILLING_REMINDERS_FLAG_NAME = "BILLING_REMINDERS_ENABLED"
export const BILLING_OCR_FLAG_NAME = "BILLING_OCR_ENABLED"
export const ACCOUNTING_AUTO_POSTING_FLAG_NAME = "ACCOUNTING_AUTO_POSTING_ENABLED"

type Env = Readonly<Record<string, string | undefined>>

export function isBillingCompleteEnabled(env: Env = process.env): boolean {
  return env[BILLING_COMPLETE_FLAG_NAME] === "true"
}
export function isBillingMailEnabled(env: Env = process.env): boolean {
  return env[BILLING_MAIL_FLAG_NAME] === "true"
}
export function isBillingRemindersEnabled(env: Env = process.env): boolean {
  return env[BILLING_REMINDERS_FLAG_NAME] === "true"
}
export function isBillingOcrEnabled(env: Env = process.env): boolean {
  return env[BILLING_OCR_FLAG_NAME] === "true"
}
export function isAccountingAutoPostingEnabled(env: Env = process.env): boolean {
  return env[ACCOUNTING_AUTO_POSTING_FLAG_NAME] === "true"
}
