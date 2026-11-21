/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8A : erreurs du coffre à secrets.
 *
 * Codes de la SECURITY-SPEC §21 seulement. Le message d'une erreur est son code : aucun détail cryptographique, aucune
 * valeur secrète, aucun texte de fournisseur ne sort du coffre (§17, §21).
 */
export const SECRET_ERROR_CODES = [
  "SECRET_NOT_CONFIGURED",
  "SECRET_DECRYPTION_FAILED",
  "SECRET_VERSION_UNSUPPORTED",
  "CONNECTION_FORBIDDEN",
  "CONNECTION_TENANT_MISMATCH",
  "CONNECTION_AUTH_REVOKED",
  "ROTATION_FAILED",
  "REVOCATION_FAILED",
  "SECURITY_CONFIGURATION_INVALID",
  "SECRET_BACKEND_MISMATCH",
] as const
export type SecretErrorCode = (typeof SECRET_ERROR_CODES)[number]

export class SecretProviderError extends Error {
  constructor(readonly code: SecretErrorCode) {
    super(code)
    this.name = "SecretProviderError"
  }
}

export const secretErrorCode = (e: unknown): SecretErrorCode | null => (e instanceof SecretProviderError ? e.code : null)
