/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B1 / STEP-2
 * Erreurs stables du repository IntegrationConnection.
 * Jamais de message Prisma / provider exposé aux couches supérieures.
 */

export const INTEGRATION_CONNECTION_ERROR = {
  NOT_FOUND: "INTEGRATION_CONNECTION_NOT_FOUND",
  VALIDATION_ERROR: "INTEGRATION_CONNECTION_VALIDATION_ERROR",
  PERSISTENCE_ERROR: "INTEGRATION_CONNECTION_PERSISTENCE_ERROR",
} as const

export type IntegrationConnectionErrorCode =
  (typeof INTEGRATION_CONNECTION_ERROR)[keyof typeof INTEGRATION_CONNECTION_ERROR]

export class IntegrationConnectionError extends Error {
  readonly code: IntegrationConnectionErrorCode

  constructor(code: IntegrationConnectionErrorCode, message: string) {
    super(message)
    this.name = "IntegrationConnectionError"
    this.code = code
  }
}

export class IntegrationConnectionNotFoundError extends IntegrationConnectionError {
  constructor(message = "IntegrationConnection introuvable pour ce tenant") {
    super(INTEGRATION_CONNECTION_ERROR.NOT_FOUND, message)
    this.name = "IntegrationConnectionNotFoundError"
  }
}

export class IntegrationConnectionValidationError extends IntegrationConnectionError {
  constructor(message = "Données IntegrationConnection invalides") {
    super(INTEGRATION_CONNECTION_ERROR.VALIDATION_ERROR, message)
    this.name = "IntegrationConnectionValidationError"
  }
}

export class IntegrationConnectionPersistenceError extends IntegrationConnectionError {
  constructor(message = "Erreur de persistance IntegrationConnection") {
    super(INTEGRATION_CONNECTION_ERROR.PERSISTENCE_ERROR, message)
    this.name = "IntegrationConnectionPersistenceError"
  }
}

export function isIntegrationConnectionError(
  error: unknown
): error is IntegrationConnectionError {
  return error instanceof IntegrationConnectionError
}

/** Prisma unique violation. */
export function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  )
}

/** Prisma foreign-key violation. */
export function isPrismaForeignKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2003"
  )
}
