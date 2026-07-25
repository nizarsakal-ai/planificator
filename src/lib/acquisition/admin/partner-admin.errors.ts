/**
 * PLAN-ACQ-012-LOT-1.5 — Erreurs métier administration registre partenaires.
 * Jamais de message / code Prisma exposé aux couches supérieures.
 */

export type PartnerAdminErrorCode =
  | "PARTNER_ALREADY_EXISTS"
  | "DOMAIN_ALREADY_EXISTS"
  | "PARTNER_NOT_FOUND"
  | "DOMAIN_NOT_FOUND"
  | "INVALID_DOMAIN"
  | "INVALID_PARTNER_CODE"
  | "INVALID_PARTNER_NAME"
  | "PERSISTENCE_ERROR"

export class PartnerAdminError extends Error {
  readonly code: PartnerAdminErrorCode

  constructor(code: PartnerAdminErrorCode, message: string) {
    super(message)
    this.name = "PartnerAdminError"
    this.code = code
  }
}

export class PartnerAlreadyExistsError extends PartnerAdminError {
  constructor(message = "Un partenaire avec ce code existe déjà pour ce tenant") {
    super("PARTNER_ALREADY_EXISTS", message)
    this.name = "PartnerAlreadyExistsError"
  }
}

export class DomainAlreadyExistsError extends PartnerAdminError {
  constructor(message = "Ce domaine existe déjà pour ce tenant") {
    super("DOMAIN_ALREADY_EXISTS", message)
    this.name = "DomainAlreadyExistsError"
  }
}

export class PartnerNotFoundError extends PartnerAdminError {
  constructor(message = "Partenaire introuvable pour ce tenant") {
    super("PARTNER_NOT_FOUND", message)
    this.name = "PartnerNotFoundError"
  }
}

export class DomainNotFoundError extends PartnerAdminError {
  constructor(message = "Domaine introuvable pour ce tenant") {
    super("DOMAIN_NOT_FOUND", message)
    this.name = "DomainNotFoundError"
  }
}

export class InvalidDomainError extends PartnerAdminError {
  constructor(message = "Domaine invalide") {
    super("INVALID_DOMAIN", message)
    this.name = "InvalidDomainError"
  }
}

export class InvalidPartnerCodeError extends PartnerAdminError {
  constructor(message = "Code partenaire invalide") {
    super("INVALID_PARTNER_CODE", message)
    this.name = "InvalidPartnerCodeError"
  }
}

export class InvalidPartnerNameError extends PartnerAdminError {
  constructor(message = "Nom partenaire invalide") {
    super("INVALID_PARTNER_NAME", message)
    this.name = "InvalidPartnerNameError"
  }
}

export class PartnerAdminPersistenceError extends PartnerAdminError {
  constructor(message = "Erreur de persistance administration partenaires") {
    super("PERSISTENCE_ERROR", message)
    this.name = "PartnerAdminPersistenceError"
  }
}

export function isPartnerAdminError(error: unknown): error is PartnerAdminError {
  return error instanceof PartnerAdminError
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  )
}
