import { createHash } from "node:crypto"
import { ZodError } from "zod"

/** Classification sûre d'une erreur d'ingestion — jamais de message brut ni de valeurs. */
export type AcquisitionIngestionCauseCode =
  | "ZOD_VALIDATION"
  | "PRISMA_UNIQUE_CONSTRAINT"
  | "PRISMA_FOREIGN_KEY"
  | "PRISMA_DATABASE_ERROR"
  | "MAPPER_ERROR"
  | "UNKNOWN_ERROR"

export type AcquisitionIngestionFailureStep =
  | "MAP_GMAIL_MESSAGE"
  | "REGISTER_INCOMING_MESSAGE"

export interface ClassifiedAcquisitionIngestionError {
  causeCode: AcquisitionIngestionCauseCode
  errorName: string
  prismaCode?: string
  /** Chemins Zod uniquement (ex. `senderEmail`, `attachments.0.filename`) — jamais les valeurs. */
  zodIssuePaths?: string[]
}

/** Hash SHA-256 tronqué (12 hex) — référence stable non réversible pour logs. */
export function hashExternalMessageId(externalMessageId: string): string {
  return createHash("sha256").update(externalMessageId, "utf8").digest("hex").slice(0, 12)
}

function isPrismaLikeError(error: unknown): error is { code: string; name?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    /^P\d{4}$/.test((error as { code: string }).code)
  )
}

/** Détection Zod robuste (évite les faux négatifs `instanceof` cross-realm / bundling). */
function isZodLikeError(
  error: unknown
): error is { name: string; issues: { path: PropertyKey[] }[] } {
  if (error instanceof ZodError) return true
  if (typeof error !== "object" || error === null) return false
  const e = error as { name?: unknown; issues?: unknown }
  return e.name === "ZodError" && Array.isArray(e.issues)
}

function zodIssuePaths(error: { issues: { path: PropertyKey[] }[] }): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)"
    if (!seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

/**
 * Classifie une erreur d'ingestion pour logs / diagnostics sûrs.
 * `step` permet de distinguer une erreur mapper d'une erreur register inconnue.
 */
export function classifyAcquisitionIngestionError(
  error: unknown,
  step: AcquisitionIngestionFailureStep
): ClassifiedAcquisitionIngestionError {
  if (isZodLikeError(error)) {
    return {
      causeCode: "ZOD_VALIDATION",
      errorName: "ZodError",
      zodIssuePaths: zodIssuePaths(error),
    }
  }

  if (isPrismaLikeError(error)) {
    const prismaCode = error.code
    if (prismaCode === "P2002") {
      return {
        causeCode: "PRISMA_UNIQUE_CONSTRAINT",
        errorName: error.name ?? "PrismaClientKnownRequestError",
        prismaCode,
      }
    }
    if (prismaCode === "P2003") {
      return {
        causeCode: "PRISMA_FOREIGN_KEY",
        errorName: error.name ?? "PrismaClientKnownRequestError",
        prismaCode,
      }
    }
    return {
      causeCode: "PRISMA_DATABASE_ERROR",
      errorName: error.name ?? "PrismaClientKnownRequestError",
      prismaCode,
    }
  }

  const errorName =
    error instanceof Error && error.name ? error.name : "Unknown"

  if (step === "MAP_GMAIL_MESSAGE") {
    return { causeCode: "MAPPER_ERROR", errorName }
  }

  return { causeCode: "UNKNOWN_ERROR", errorName }
}

/** Payload de log métier — aucun secret, corps, valeur Zod, SQL ou stack. */
export interface AcquisitionIngestionFailureLogPayload {
  companyId: string
  messageIdHash: string
  step: AcquisitionIngestionFailureStep
  errorName: string
  causeCode: AcquisitionIngestionCauseCode
  prismaCode?: string
  zodIssuePaths?: string[]
}

export function buildAcquisitionIngestionFailureLogPayload(input: {
  companyId: string
  externalMessageId: string
  step: AcquisitionIngestionFailureStep
  error: unknown
}): AcquisitionIngestionFailureLogPayload {
  const classified = classifyAcquisitionIngestionError(input.error, input.step)
  return {
    companyId: input.companyId,
    messageIdHash: hashExternalMessageId(input.externalMessageId),
    step: input.step,
    errorName: classified.errorName,
    causeCode: classified.causeCode,
    ...(classified.prismaCode ? { prismaCode: classified.prismaCode } : {}),
    ...(classified.zodIssuePaths ? { zodIssuePaths: classified.zodIssuePaths } : {}),
  }
}
