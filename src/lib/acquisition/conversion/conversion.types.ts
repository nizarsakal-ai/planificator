/**
 * PLAN-ACQ-005D — Types conversion métier.
 */

import type { Role } from "@prisma/client"

export type ConversionActorContext = {
  actorUserId: string
  actorRole: Role
  companyId: string
}

export type ConvertImportDraftSuccess = {
  ok: true
  outcome: "CONVERTED" | "ALREADY_CONVERTED"
  worksiteId: string
  clientId: string
  clientCreated: boolean
  documentCount: number
  skippedAttachmentCount: number
}

export type ConvertImportDraftFailure = {
  ok: false
  outcome:
    | "STATE_CHANGED"
    | "INVALID_STATE"
    | "VALIDATION_ERROR"
    | "CLIENT_NOT_FOUND"
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "DISABLED"
    | "INTERNAL_ERROR"
  code: string
  message: string
}

export type ConvertImportDraftResult = ConvertImportDraftSuccess | ConvertImportDraftFailure

/** Exception interne pour forcer le rollback Prisma interactive transaction. */
export class ConversionClaimConflictError extends Error {
  constructor() {
    super("CONVERSION_CLAIM_CONFLICT")
    this.name = "ConversionClaimConflictError"
  }
}
