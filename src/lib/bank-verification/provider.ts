// SPEC-BANK-VERIF-001 — port « prestataire de vérification de compte » et sélection de l'adaptateur.
// Contrat : `start` ouvre un parcours CHEZ le prestataire (redirection) ; `fetchResult` relit le résultat SERVEUR À SERVEUR.
// Le statut « Vérifié » ne dépend jamais des paramètres de l'URL de retour.
//
// Adaptateurs disponibles : `sandbox` (essais hors production UNIQUEMENT). Aucun adaptateur de prestataire réel n'est livré :
// il suppose un contrat et des identifiants (parcours d'authentification bancaire du titulaire, type « vérification d'identité
// bancaire » en open banking). Sans adaptateur configuré, la fonctionnalité signale le blocage et ne vérifie rien.

export interface VerificationStart { iban: string; holderName: string; state: string; returnUrl: string }
export interface VerificationStarted { redirectUrl: string; providerRef: string }
export type VerificationOutcome =
  | { status: "CONFIRMED"; iban: string; holderName: string }
  | { status: "REJECTED"; reason: string }
  | { status: "PENDING" }

export interface VerificationSessionRef { providerRef: string | null; iban: string; result: unknown }

export interface BankVerificationProvider {
  readonly name: string
  start(input: VerificationStart): Promise<VerificationStarted>
  fetchResult(session: VerificationSessionRef): Promise<VerificationOutcome>
}

export class BankProviderError extends Error { constructor(message: string) { super(message); this.name = "BankProviderError" } }

type Env = Readonly<Record<string, string | undefined>>
export const BANK_VERIFICATION_PROVIDER_ENV = "BANK_VERIFICATION_PROVIDER"

export function isProductionEnv(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production" || (env.NODE_ENV === "production" && env.VERCEL_ENV === undefined)
}

export const SANDBOX_OUTCOMES = ["CONFIRMED", "REJECTED", "HOLDER_MISMATCH", "OTHER_IBAN", "PENDING"] as const
export type SandboxOutcome = (typeof SANDBOX_OUTCOMES)[number]

/**
 * Simulateur de prestataire pour les essais : le « parcours » est une page interne où le testeur choisit l'issue, enregistrée
 * côté serveur sur la session de vérification (jamais transmise par l'URL de retour). Refusé en production.
 */
export class SandboxBankVerificationProvider implements BankVerificationProvider {
  readonly name = "sandbox"
  async start(input: VerificationStart): Promise<VerificationStarted> {
    return { redirectUrl: `/comptabilite/banque/verification/sandbox?state=${encodeURIComponent(input.state)}`, providerRef: `sandbox-${input.state.slice(0, 12)}` }
  }
  async fetchResult(session: VerificationSessionRef): Promise<VerificationOutcome> {
    const outcome = (session.result as { sandboxOutcome?: unknown; holderName?: unknown } | null)?.sandboxOutcome
    const holder = String((session.result as { holderName?: unknown } | null)?.holderName ?? "")
    switch (outcome) {
      case "CONFIRMED": return { status: "CONFIRMED", iban: session.iban, holderName: holder }
      case "HOLDER_MISMATCH": return { status: "CONFIRMED", iban: session.iban, holderName: "Titulaire Différent SARL" }
      case "OTHER_IBAN": return { status: "CONFIRMED", iban: "FR7630006000011234567890189", holderName: holder }
      case "REJECTED": return { status: "REJECTED", reason: "Parcours refusé ou abandonné chez le prestataire." }
      default: return { status: "PENDING" }
    }
  }
}

export type ProviderResolution = { ok: true; provider: BankVerificationProvider } | { ok: false; reason: "NOT_CONFIGURED" | "SANDBOX_IN_PRODUCTION" | "UNKNOWN_PROVIDER" }

let override: BankVerificationProvider | null = null
export function setBankVerificationProviderForTests(p: BankVerificationProvider | null): void { override = p }

export function resolveBankVerificationProvider(env: Env = process.env): ProviderResolution {
  if (override) return { ok: true, provider: override }
  const name = (env[BANK_VERIFICATION_PROVIDER_ENV] ?? "").trim().toLowerCase()
  if (!name) return { ok: false, reason: "NOT_CONFIGURED" }
  if (name === "sandbox") return isProductionEnv(env) ? { ok: false, reason: "SANDBOX_IN_PRODUCTION" } : { ok: true, provider: new SandboxBankVerificationProvider() }
  return { ok: false, reason: "UNKNOWN_PROVIDER" }
}

export const PROVIDER_BLOCKED_MESSAGE: Record<Exclude<ProviderResolution, { ok: true }>["reason"], string> = {
  NOT_CONFIGURED: "Vérification indisponible : aucun prestataire de vérification bancaire n'est configuré pour Planificator. L'IBAN peut être enregistré, mais il ne sera pas marqué « Vérifié ».",
  SANDBOX_IN_PRODUCTION: "Vérification indisponible : le simulateur d'essai ne peut pas être utilisé en production.",
  UNKNOWN_PROVIDER: "Vérification indisponible : le prestataire configuré n'est pas pris en charge.",
}
