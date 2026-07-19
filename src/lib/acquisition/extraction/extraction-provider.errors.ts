/**
 * PLAN-ACQ-005B — Erreurs typées du port provider (pas de statut métier).
 */

export type ExtractionProviderErrorCode =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_INVALID_OUTPUT"
  | "PROVIDER_DISABLED"

export class ExtractionProviderError extends Error {
  readonly code: ExtractionProviderErrorCode
  readonly retryable: boolean

  constructor(code: ExtractionProviderErrorCode, message: string, retryable: boolean) {
    super(message)
    this.name = "ExtractionProviderError"
    this.code = code
    this.retryable = retryable
  }
}

export function isExtractionProviderError(error: unknown): error is ExtractionProviderError {
  return error instanceof ExtractionProviderError
}
