/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
 * Taxonomie d’erreurs InboundEnvelope / NormalizedInbound (SPEC §13).
 * Jamais de meta / message Prisma exposé aux couches supérieures.
 */

export const INTEGRATION_INBOUND_ERROR = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  PERSISTENCE: "PERSISTENCE",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  LIFECYCLE_CONFLICT: "LIFECYCLE_CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  NORMALIZED_VERSION_CONFLICT: "NORMALIZED_VERSION_CONFLICT",
} as const

export type IntegrationInboundErrorCode =
  (typeof INTEGRATION_INBOUND_ERROR)[keyof typeof INTEGRATION_INBOUND_ERROR]

export class IntegrationInboundError extends Error {
  readonly code: IntegrationInboundErrorCode

  constructor(code: IntegrationInboundErrorCode, message: string) {
    super(message)
    this.name = "IntegrationInboundError"
    this.code = code
  }
}

export class IntegrationInboundValidationError extends IntegrationInboundError {
  constructor(message = "Données inbound invalides") {
    super(INTEGRATION_INBOUND_ERROR.VALIDATION, message)
    this.name = "IntegrationInboundValidationError"
  }
}

export class IntegrationInboundNotFoundError extends IntegrationInboundError {
  constructor(message = "Ressource inbound introuvable pour ce tenant") {
    super(INTEGRATION_INBOUND_ERROR.NOT_FOUND, message)
    this.name = "IntegrationInboundNotFoundError"
  }
}

export class IntegrationInboundPersistenceError extends IntegrationInboundError {
  constructor(message = "Erreur de persistance inbound") {
    super(INTEGRATION_INBOUND_ERROR.PERSISTENCE, message)
    this.name = "IntegrationInboundPersistenceError"
  }
}

export class IntegrationInboundIdempotencyConflictError extends IntegrationInboundError {
  constructor(message = "Conflit d’idempotence Envelope") {
    super(INTEGRATION_INBOUND_ERROR.IDEMPOTENCY_CONFLICT, message)
    this.name = "IntegrationInboundIdempotencyConflictError"
  }
}

export class IntegrationInboundLifecycleConflictError extends IntegrationInboundError {
  constructor(message = "Conflit de lifecycle Envelope") {
    super(INTEGRATION_INBOUND_ERROR.LIFECYCLE_CONFLICT, message)
    this.name = "IntegrationInboundLifecycleConflictError"
  }
}

export class IntegrationInboundPayloadTooLargeError extends IntegrationInboundError {
  constructor(message = "Payload NormalizedInbound trop volumineux") {
    super(INTEGRATION_INBOUND_ERROR.PAYLOAD_TOO_LARGE, message)
    this.name = "IntegrationInboundPayloadTooLargeError"
  }
}

export class IntegrationInboundNormalizedVersionConflictError extends IntegrationInboundError {
  constructor(message = "Conflit de version NormalizedInbound") {
    super(INTEGRATION_INBOUND_ERROR.NORMALIZED_VERSION_CONFLICT, message)
    this.name = "IntegrationInboundNormalizedVersionConflictError"
  }
}

export function isIntegrationInboundError(
  error: unknown
): error is IntegrationInboundError {
  return error instanceof IntegrationInboundError
}

export function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  )
}

export function isPrismaForeignKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2003"
  )
}

/** Noms SQL figés SPEC — matching P2002 interne uniquement. */
export const INBOUND_CONSTRAINT = {
  IDEMPOTENCY: "integration_inbound_envelopes_idempotency_key",
  ENVELOPE_VERSION: "integration_normalized_inbounds_envelope_version_key",
} as const

export function prismaUniqueConstraintName(error: unknown): string | null {
  if (!isPrismaUniqueConstraintError(error)) return null
  const meta = (error as { meta?: { target?: unknown; constraint?: unknown } })
    .meta
  if (typeof meta?.constraint === "string") return meta.constraint
  if (Array.isArray(meta?.target)) {
    const fields = meta.target.map(String)
    if (
      fields.includes("companyId") &&
      fields.includes("connectionId") &&
      fields.includes("idempotencyKey")
    ) {
      return INBOUND_CONSTRAINT.IDEMPOTENCY
    }
    if (
      fields.includes("envelopeId") &&
      fields.includes("companyId") &&
      fields.includes("family") &&
      fields.includes("schemaVersion")
    ) {
      return INBOUND_CONSTRAINT.ENVELOPE_VERSION
    }
  }
  return null
}
