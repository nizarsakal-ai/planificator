import { NextResponse } from "next/server"
import { auth } from "@/auth"
import type { Role } from "@prisma/client"
import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { contentHashPrefix } from "@/lib/acquisition/content/content-fetch-feature-flag"
import {
  fetchAndStoreMessageContent,
  getMessageContentForCompany,
  type MessageContentServiceDeps,
} from "@/lib/acquisition/content/message-content.service"
import type { MessageContentErrorCode } from "@/lib/acquisition/content/message-content.types"

export interface HandleMessageContentDeps extends MessageContentServiceDeps {
  auth?: () => Promise<{
    user: { id: string; role: Role; companyId: string | null }
  } | null>
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
}

function jsonResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: SECURITY_HEADERS })
}

function statusFor(code: MessageContentErrorCode): number {
  switch (code) {
    case "CONTENT_UNAUTHORIZED":
      return 401
    case "CONTENT_FORBIDDEN":
    case "CONTENT_FETCH_DISABLED":
      return 403
    case "CONTENT_NOT_FOUND":
    case "GMAIL_MESSAGE_NOT_FOUND":
      return 404
    case "CONTENT_EMPTY":
    case "ACQUISITION_CONTENT_TOO_LARGE":
      return 422
    case "GMAIL_RATE_LIMITED":
      return 429
    case "GMAIL_NOT_CONNECTED":
    case "GMAIL_TOKEN_REFRESH_FAILED":
    case "GMAIL_UNAUTHORIZED":
    case "GMAIL_UNAVAILABLE":
    case "GMAIL_MESSAGE_PARSE_ERROR":
    case "CONTENT_FETCH_FAILED":
    case "CONTENT_PERSIST_FAILED":
      return 502
    default:
      return 500
  }
}

/** GET — lecture tenant-scopée du contenu déjà persisté (sans re-fetch). */
export async function handleGetMessageContent(
  _req: Request,
  acquisitionMessageId: string,
  deps: HandleMessageContentDeps = {}
): Promise<Response> {
  const authenticate = deps.auth ?? auth
  const session = await authenticate()
  if (!session?.user?.id) {
    return jsonResponse({ ok: false, code: "CONTENT_UNAUTHORIZED", message: "Non autorisé" }, 401)
  }
  if (!isAcquisitionEnabled()) {
    return jsonResponse(
      { ok: false, code: "CONTENT_FETCH_DISABLED", message: "Module acquisition désactivé" },
      403
    )
  }
  if (!session.user.companyId || !["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return jsonResponse({ ok: false, code: "CONTENT_FORBIDDEN", message: "Accès refusé" }, 403)
  }

  const content = await getMessageContentForCompany(
    session.user.companyId,
    acquisitionMessageId,
    deps
  )
  if (!content) {
    return jsonResponse(
      { ok: false, code: "CONTENT_NOT_FOUND", message: "Contenu introuvable" },
      404
    )
  }

  return jsonResponse(
    {
      ok: true,
      content: {
        acquisitionMessageId: content.acquisitionMessageId,
        normalizedText: content.normalizedText,
        contentHash: content.contentHash,
        sourceMimeType: content.sourceMimeType,
        hadHtml: content.hadHtml,
        byteLength: Buffer.byteLength(content.normalizedText, "utf8"),
        fetchedAt: content.fetchedAt.toISOString(),
        sanitizedAt: content.sanitizedAt.toISOString(),
      },
    },
    200
  )
}

/** POST — déclenche fetch Gmail + sanitize + upsert. Jamais de normalizedText. */
export async function handleFetchMessageContent(
  _req: Request,
  acquisitionMessageId: string,
  deps: HandleMessageContentDeps = {}
): Promise<Response> {
  const authenticate = deps.auth ?? auth
  const session = await authenticate()
  if (!session?.user?.id) {
    return jsonResponse({ ok: false, code: "CONTENT_UNAUTHORIZED", message: "Non autorisé" }, 401)
  }

  const result = await fetchAndStoreMessageContent(
    {
      actor: {
        userId: session.user.id,
        role: session.user.role,
        companyId: session.user.companyId,
      },
      acquisitionMessageId,
    },
    deps
  )

  if (!result.ok) {
    return jsonResponse(
      {
        ok: false,
        outcome: result.outcome,
        code: result.code,
        message: result.message,
      },
      statusFor(result.code)
    )
  }

  return jsonResponse(
    {
      ok: true,
      outcome: result.outcome,
      contentId: result.content.id,
      acquisitionMessageId: result.content.acquisitionMessageId,
      hashPrefix: contentHashPrefix(result.content.contentHash),
      byteLength: Buffer.byteLength(result.content.normalizedText, "utf8"),
      fetchedAt: result.content.fetchedAt.toISOString(),
      updatedAt: result.content.updatedAt.toISOString(),
      idempotent: result.idempotent,
      changed: result.outcome !== "ALREADY_FETCHED",
    },
    200
  )
}
