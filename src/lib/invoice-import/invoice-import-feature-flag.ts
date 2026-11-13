/**
 * Drapeaux serveur (fail-closed, valeur exacte "true", jamais NEXT_PUBLIC_*) — SPEC-INVOICE-IMPORT-001.
 * - INVOICE_IMPORT_ENABLED : import de factures clients/avoirs depuis Tiime ou un autre logiciel (en plus de BILLING_COMPLETE_ENABLED).
 * - BANK_ACCOUNT_VERIFICATION_ENABLED : saisie de l'IBAN de la société et liaison/vérification du compte (en plus du module comptable).
 */
type Env = Readonly<Record<string, string | undefined>>
export const INVOICE_IMPORT_FLAG_NAME = "INVOICE_IMPORT_ENABLED"
export const BANK_ACCOUNT_VERIFICATION_FLAG_NAME = "BANK_ACCOUNT_VERIFICATION_ENABLED"
export function isInvoiceImportEnabled(env: Env = process.env): boolean {
  return env[INVOICE_IMPORT_FLAG_NAME] === "true"
}
export function isBankAccountVerificationEnabled(env: Env = process.env): boolean {
  return env[BANK_ACCOUNT_VERIFICATION_FLAG_NAME] === "true"
}
