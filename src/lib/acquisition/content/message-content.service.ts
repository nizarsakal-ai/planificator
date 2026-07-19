import type { PrismaClient, Role } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import {
  contentHashPrefix,
  getContentFetchMaxRawBytes,
  getContentNormalizedMaxBytes,
  isAcquisitionContentFetchEnabled,
} from "@/lib/acquisition/content/content-fetch-feature-flag"
import type { AcquisitionMessageContentSourcePort } from "@/lib/acquisition/content/message-content-source.port"
import { gmailMessageContentSource } from "@/lib/acquisition/content/gmail-message-content-source.adapter"
import { AcquisitionMessageContentRepository } from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import type {
  FetchMessageContentResult,
  MessageContentErrorCode,
  MessageContentRecord,
} from "@/lib/acquisition/content/message-content.types"
import { isGmailProviderError } from "@/lib/acquisition/connector/gmail-api.client"

const ALLOWED_ROLES = new Set<Role>(["ADMIN", "SUPER_ADMIN"])

export interface MessageContentActor {
  userId: string
  role: Role
  companyId: string | null
}

export interface MessageContentServiceDeps {
  db?: PrismaClient
  source?: AcquisitionMessageContentSourcePort
  repository?: AcquisitionMessageContentRepository
}

function fail(
  outcome: Extract<FetchMessageContentResult, { ok: false }>["outcome"],
  code: MessageContentErrorCode,
  message: string
): FetchMessageContentResult {
  return { ok: false, outcome, code, message }
}

function mapGmailCode(code: string): MessageContentErrorCode {
  switch (code) {
    case "GMAIL_NOT_CONNECTED":
    case "GMAIL_TOKEN_REFRESH_FAILED":
    case "GMAIL_UNAUTHORIZED":
    case "GMAIL_RATE_LIMITED":
    case "GMAIL_UNAVAILABLE":
    case "GMAIL_MESSAGE_NOT_FOUND":
    case "GMAIL_MESSAGE_PARSE_ERROR":
      return code
    default:
      return "CONTENT_FETCH_FAILED"
  }
}

function publicMessage(code: MessageContentErrorCode): string {
  switch (code) {
    case "CONTENT_FETCH_DISABLED":
      return "Récupération du contenu désactivée"
    case "CONTENT_UNAUTHORIZED":
      return "Non autorisé"
    case "CONTENT_FORBIDDEN":
      return "Accès refusé"
    case "CONTENT_NOT_FOUND":
      return "Message introuvable"
    case "CONTENT_EMPTY":
      return "Aucun contenu textuel exploitable"
    case "ACQUISITION_CONTENT_TOO_LARGE":
      return "Contenu trop volumineux"
    case "CONTENT_PERSIST_FAILED":
      return "Échec de persistance du contenu"
    case "GMAIL_NOT_CONNECTED":
      return "Boîte Gmail non connectée"
    case "GMAIL_TOKEN_REFRESH_FAILED":
    case "GMAIL_UNAUTHORIZED":
      return "Connexion Gmail invalide"
    case "GMAIL_RATE_LIMITED":
      return "Limite Gmail atteinte, réessayez plus tard"
    case "GMAIL_MESSAGE_NOT_FOUND":
      return "Message Gmail introuvable ou supprimé"
    case "GMAIL_UNAVAILABLE":
      return "Service Gmail indisponible"
    default:
      return "Échec de récupération du contenu"
  }
}

export function canAccessMessageContent(actor: MessageContentActor): boolean {
  if (!actor.userId || !ALLOWED_ROLES.has(actor.role)) return false
  return Boolean(actor.companyId)
}

export async function getMessageContentForCompany(
  companyId: string,
  acquisitionMessageId: string,
  deps: MessageContentServiceDeps = {}
): Promise<MessageContentRecord | null> {
  if (!companyId || !acquisitionMessageId) return null
  const repository = deps.repository ?? new AcquisitionMessageContentRepository(deps.db ?? prisma)
  return repository.findByMessage(companyId, acquisitionMessageId)
}

/**
 * Fetch à la demande → sanitize → upsert idempotent.
 * N'écrit jamais de MIME brut ni de proposed* draft.
 * Aucune troncature : dépassement → ACQUISITION_CONTENT_TOO_LARGE.
 */
export async function fetchAndStoreMessageContent(
  input: {
    actor: MessageContentActor
    acquisitionMessageId: string
  },
  deps: MessageContentServiceDeps = {}
): Promise<FetchMessageContentResult> {
  if (!isAcquisitionEnabled() || !isAcquisitionContentFetchEnabled()) {
    return fail("DISABLED", "CONTENT_FETCH_DISABLED", publicMessage("CONTENT_FETCH_DISABLED"))
  }
  if (!input.actor.userId) {
    return fail("UNAUTHORIZED", "CONTENT_UNAUTHORIZED", publicMessage("CONTENT_UNAUTHORIZED"))
  }
  if (!canAccessMessageContent(input.actor) || !input.actor.companyId) {
    return fail("FORBIDDEN", "CONTENT_FORBIDDEN", publicMessage("CONTENT_FORBIDDEN"))
  }

  const companyId = input.actor.companyId
  const db = deps.db ?? prisma
  const repository = deps.repository ?? new AcquisitionMessageContentRepository(db)
  const source = deps.source ?? gmailMessageContentSource

  const message = await db.acquisitionMessage.findFirst({
    where: { id: input.acquisitionMessageId, companyId },
    select: { id: true, externalMessageId: true, companyId: true },
  })
  if (!message) {
    return fail("NOT_FOUND", "CONTENT_NOT_FOUND", publicMessage("CONTENT_NOT_FOUND"))
  }

  let parts
  try {
    parts = await source.fetchMessageBody({
      companyId,
      externalMessageId: message.externalMessageId,
    })
  } catch (error) {
    if (isGmailProviderError(error)) {
      const code = mapGmailCode(error.code)
      return fail("FAILED", code, publicMessage(code))
    }
    return fail("FAILED", "CONTENT_FETCH_FAILED", publicMessage("CONTENT_FETCH_FAILED"))
  }

  if (parts.byteLengthOriginal > getContentFetchMaxRawBytes()) {
    return fail(
      "ACQUISITION_CONTENT_TOO_LARGE",
      "ACQUISITION_CONTENT_TOO_LARGE",
      publicMessage("ACQUISITION_CONTENT_TOO_LARGE")
    )
  }

  const sanitized = sanitizeMessageBodyParts(parts)
  if (!sanitized.normalizedText.trim()) {
    return fail("EMPTY_CONTENT", "CONTENT_EMPTY", publicMessage("CONTENT_EMPTY"))
  }

  if (sanitized.byteLengthNormalized > getContentNormalizedMaxBytes()) {
    return fail(
      "ACQUISITION_CONTENT_TOO_LARGE",
      "ACQUISITION_CONTENT_TOO_LARGE",
      publicMessage("ACQUISITION_CONTENT_TOO_LARGE")
    )
  }

  const fetchedAt = new Date()
  let upsert
  try {
    upsert = await repository.upsertNormalized({
      companyId,
      acquisitionMessageId: message.id,
      sanitized,
      fetchedAt,
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return fail("FAILED", "CONTENT_PERSIST_FAILED", publicMessage("CONTENT_PERSIST_FAILED"))
    }
    return fail("FAILED", "CONTENT_PERSIST_FAILED", publicMessage("CONTENT_PERSIST_FAILED"))
  }

  console.info(
    JSON.stringify({
      scope: "acquisition-message-content",
      event: "CONTENT_FETCHED",
      companyId,
      acquisitionMessageId: message.id,
      hashPrefix: contentHashPrefix(upsert.record.contentHash),
      outcome: upsert.outcome,
      byteLengthNormalized: sanitized.byteLengthNormalized,
      byteLengthOriginal: upsert.record.byteLengthOriginal,
      actorId: input.actor.userId,
    })
  )

  return {
    ok: true,
    outcome: upsert.outcome,
    content: upsert.record,
    idempotent: upsert.outcome === "ALREADY_FETCHED",
  }
}
