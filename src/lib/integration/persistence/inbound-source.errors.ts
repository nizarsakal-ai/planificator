/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Erreurs stables Source / Rule — jamais de meta Prisma exposée.
 */

export const INBOUND_SOURCE_ERROR = {
  VALIDATION: "INBOUND_SOURCE_VALIDATION",
  NOT_FOUND: "INBOUND_SOURCE_NOT_FOUND",
  PERSISTENCE: "INBOUND_SOURCE_PERSISTENCE",
  CONFLICT: "INBOUND_SOURCE_CONFLICT",
  LIMIT_EXCEEDED: "INBOUND_SOURCE_LIMIT_EXCEEDED",
  IDENTITY_REQUIRED: "INBOUND_SOURCE_IDENTITY_REQUIRED",
} as const

export type InboundSourceErrorCode =
  (typeof INBOUND_SOURCE_ERROR)[keyof typeof INBOUND_SOURCE_ERROR]

export class InboundSourceError extends Error {
  readonly code: InboundSourceErrorCode

  constructor(code: InboundSourceErrorCode, message: string) {
    super(message)
    this.name = "InboundSourceError"
    this.code = code
  }
}

export class InboundSourceValidationError extends InboundSourceError {
  constructor(message = "Données Source/Rule invalides") {
    super(INBOUND_SOURCE_ERROR.VALIDATION, message)
    this.name = "InboundSourceValidationError"
  }
}

export class InboundSourceNotFoundError extends InboundSourceError {
  constructor(message = "Source ou Rule introuvable pour ce tenant") {
    super(INBOUND_SOURCE_ERROR.NOT_FOUND, message)
    this.name = "InboundSourceNotFoundError"
  }
}

export class InboundSourcePersistenceError extends InboundSourceError {
  constructor(message = "Erreur de persistance Source/Rule") {
    super(INBOUND_SOURCE_ERROR.PERSISTENCE, message)
    this.name = "InboundSourcePersistenceError"
  }
}

export class InboundSourceConflictError extends InboundSourceError {
  constructor(message = "Conflit d’unicité Source/Rule") {
    super(INBOUND_SOURCE_ERROR.CONFLICT, message)
    this.name = "InboundSourceConflictError"
  }
}

export class InboundSourceLimitExceededError extends InboundSourceError {
  constructor(message = "Plafond Source/Rule dépassé") {
    super(INBOUND_SOURCE_ERROR.LIMIT_EXCEEDED, message)
    this.name = "InboundSourceLimitExceededError"
  }
}

export class InboundSourceIdentityRequiredError extends InboundSourceError {
  constructor(
    message = "Source enabled exige ≥ 1 rule IDENTITÉ enabled"
  ) {
    super(INBOUND_SOURCE_ERROR.IDENTITY_REQUIRED, message)
    this.name = "InboundSourceIdentityRequiredError"
  }
}

export function isInboundSourceError(
  error: unknown
): error is InboundSourceError {
  return error instanceof InboundSourceError
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

export const SOURCE_CONSTRAINT = {
  ID_COMPANY: "integration_inbound_sources_id_companyId_key",
  RULE_ID_COMPANY: "integration_inbound_source_rules_id_companyId_key",
  RULE_MATCH: "integration_inbound_source_rules_match_key",
} as const

export function prismaUniqueConstraintName(error: unknown): string | null {
  if (!isPrismaUniqueConstraintError(error)) return null
  const meta = (error as { meta?: { target?: string | string[] } }).meta
  const target = meta?.target
  if (typeof target === "string") return target
  if (Array.isArray(target)) return target.join("_")
  return null
}
