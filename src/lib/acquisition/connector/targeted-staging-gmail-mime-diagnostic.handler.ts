/**
 * Harness temporaire Staging Preview — diagnostic MIME Gmail CIBLÉ (un seul AcquisitionMessage).
 * Fail-closed. Cible via env uniquement (id interne AcquisitionMessage + companyId).
 *
 * CHECK : aucune acquisition de token, aucun appel Gmail, aucune écriture.
 * RUN   : getValidAccessToken (refresh OAuth normal autorisé : accessToken + tokenExpiry)
 *         puis messages.get format=full. Jamais getAttachment, jamais de persistance du payload.
 * Sortie : métadonnées des parts image/* nommées uniquement (Content-Disposition / Content-ID).
 * Aucun token, payload, body.data, attachmentId, snippet, sujet, expéditeur ou autre header exposé.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type {
  GmailMessagePart,
  GmailMessageResource,
} from "@/lib/acquisition/connector/gmail-api.types"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

export const TARGETED_GMAIL_MIME_DIAGNOSTIC_CHECK_CONFIRMATION =
  "CHECK_TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC" as const
export const TARGETED_GMAIL_MIME_DIAGNOSTIC_RUN_CONFIRMATION =
  "RUN_TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC" as const

/** planificator-staging (Preview only). */
export const GMAIL_MIME_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const GMAIL_MIME_DIAGNOSTIC_ENABLED_FLAG = "TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_ENABLED"
export const GMAIL_MIME_DIAGNOSTIC_COMPANY_ENV = "TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_COMPANY_ID"
export const GMAIL_MIME_DIAGNOSTIC_MESSAGE_ENV = "TARGETED_STAGING_GMAIL_MIME_DIAGNOSTIC_MESSAGE_ID"

/** Seule clé acceptée dans le body. */
const ALLOWED_BODY_KEYS = new Set(["confirmation"])

/**
 * Clés de ciblage interdites, comparées après normalisation (minuscules, sans « _ » / « - ») :
 * couvre camelCase, snake_case, kebab-case et variantes de casse.
 */
const FORBIDDEN_TARGET_KEYS = new Set(
  [
    "companyId",
    "messageId",
    "acquisitionMessageId",
    "externalMessageId",
    "gmailMessageId",
    "connectionId",
    "sourceMailboxKey",
    "mailboxKey",
    "draftId",
    "attachmentId",
    "target",
  ].map(normalizeKey)
)

/** Bornes de parcours MIME (défense contre payload pathologique). */
const MAX_MIME_DEPTH = 32
const MAX_MIME_PARTS = 500
const MAX_HEADER_VALUE_LENGTH = 512

/** Codes provider exposables (jamais le message brut : il peut contenir des détails OAuth). */
const EXPOSABLE_PROVIDER_CODES = new Set<string>([
  "GMAIL_NOT_CONNECTED",
  "GMAIL_TOKEN_REFRESH_FAILED",
  "GMAIL_UNAUTHORIZED",
  "GMAIL_RATE_LIMITED",
  "GMAIL_UNAVAILABLE",
  "GMAIL_MESSAGE_NOT_FOUND",
])

export type GmailMimeDiagnosticSession = {
  user: { id: string; role: string; companyId: string | null }
} | null

export type GmailMimeDiagnosticMessageTarget = {
  id: string
  companyId: string
  externalMessageId: string | null
  sourceMailboxKey: string | null
}

export type GmailMimeDiagnosticImagePart = {
  partId: string | null
  filename: string
  mimeType: string
  sizeBytes: number | null
  hasAttachmentId: boolean
  contentDisposition: string | null
  contentId: string | null
}

export type TargetedGmailMimeDiagnosticHandlerDeps = {
  auth?: () => Promise<GmailMimeDiagnosticSession>
  env?: Record<string, string | undefined>
  loadMessageTarget?: (
    companyId: string,
    messageId: string
  ) => Promise<GmailMimeDiagnosticMessageTarget | null>
  getValidAccessToken?: (lookup: { companyId: string; connectionId: string }) => Promise<string>
  getMessage?: (accessToken: string, externalMessageId: string) => Promise<GmailMessageResource>
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isGmailMimeDiagnosticSurfaceAllowed(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    env.VERCEL_PROJECT_ID === GMAIL_MIME_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID
  )
}

function readHeader(part: GmailMessagePart, name: string): string | null {
  const wanted = name.toLowerCase()
  for (const header of part.headers ?? []) {
    if (typeof header?.name === "string" && header.name.toLowerCase() === wanted) {
      return typeof header.value === "string"
        ? header.value.slice(0, MAX_HEADER_VALUE_LENGTH)
        : null
    }
  }
  return null
}

/**
 * Parcours récursif (payload racine inclus) borné en profondeur et en nombre de parts.
 * Retourne uniquement les parts nommées dont le mimeType commence par « image/ »,
 * réduites à la liste blanche de champs (ni body.data, ni attachmentId brut, ni autres headers).
 */
export function extractImageMimeParts(
  payload: GmailMessagePart | undefined | null
): { parts: GmailMimeDiagnosticImagePart[]; truncated: boolean } {
  const parts: GmailMimeDiagnosticImagePart[] = []
  let visited = 0
  let truncated = false

  const visit = (part: GmailMessagePart | undefined | null, depth: number): void => {
    if (!part || typeof part !== "object") return
    if (depth > MAX_MIME_DEPTH || visited >= MAX_MIME_PARTS) {
      truncated = true
      return
    }
    visited++

    const filename = typeof part.filename === "string" ? part.filename.trim() : ""
    const mimeType = typeof part.mimeType === "string" ? part.mimeType.trim().toLowerCase() : ""
    if (filename && mimeType.startsWith("image/")) {
      const size = part.body?.size
      parts.push({
        partId: typeof part.partId === "string" ? part.partId : null,
        filename,
        mimeType,
        sizeBytes: typeof size === "number" && Number.isFinite(size) ? size : null,
        hasAttachmentId:
          typeof part.body?.attachmentId === "string" && part.body.attachmentId.length > 0,
        contentDisposition: readHeader(part, "Content-Disposition"),
        contentId: readHeader(part, "Content-ID"),
      })
    }

    if (Array.isArray(part.parts)) {
      for (const child of part.parts) visit(child, depth + 1)
    }
  }

  visit(payload, 0)
  return { parts, truncated }
}

async function defaultLoadMessageTarget(
  companyId: string,
  messageId: string
): Promise<GmailMimeDiagnosticMessageTarget | null> {
  return prisma.acquisitionMessage.findFirst({
    where: { id: messageId, companyId },
    select: { id: true, companyId: true, externalMessageId: true, sourceMailboxKey: true },
  })
}

function defaultGetValidAccessToken(lookup: {
  companyId: string
  connectionId: string
}): Promise<string> {
  return new PrismaAcquisitionGmailConnectionClient().getValidAccessToken(lookup)
}

function defaultGetMessage(
  accessToken: string,
  externalMessageId: string
): Promise<GmailMessageResource> {
  return new FetchGmailApiClient().getMessage(accessToken, externalMessageId)
}

/** Code d'erreur provider sûr : jamais message / stack / cause (fuite potentielle de secrets). */
function safeProviderCode(err: unknown): string | null {
  if (err instanceof GmailProviderError && EXPOSABLE_PROVIDER_CODES.has(err.code)) {
    return err.code
  }
  return null
}

function refused(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, code, message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } }
  )
}

function ok(body: Record<string, unknown>) {
  return NextResponse.json(
    { ok: true, harness: "targeted-staging-gmail-mime-diagnostic", ...body },
    { headers: { "Cache-Control": "no-store" } }
  )
}

export async function handleTargetedStagingGmailMimeDiagnostic(
  req: Request,
  deps: TargetedGmailMimeDiagnosticHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isGmailMimeDiagnosticSurfaceAllowed(env)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }
  if (env[GMAIL_MIME_DIAGNOSTIC_ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? (auth as unknown as () => Promise<GmailMimeDiagnosticSession>)
  const session = await authenticate()
  if (!session?.user) {
    return refused(401, "UNAUTHORIZED", "Non authentifié")
  }
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    return refused(403, "FORBIDDEN", "Rôle insuffisant")
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return refused(400, "INVALID_BODY", "JSON invalide")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refused(400, "INVALID_BODY", "Objet JSON attendu")
  }

  const keys = Object.keys(body)
  if (keys.some((k) => FORBIDDEN_TARGET_KEYS.has(normalizeKey(k)))) {
    return refused(
      400,
      "TARGET_OVERRIDE_FORBIDDEN",
      "La cible ne peut pas être fournie dans la requête"
    )
  }
  if (keys.some((k) => !ALLOWED_BODY_KEYS.has(k))) {
    return refused(400, "UNKNOWN_FIELD", "Champ non autorisé dans la requête")
  }

  const confirmation = (body as { confirmation?: unknown }).confirmation
  const mode =
    confirmation === TARGETED_GMAIL_MIME_DIAGNOSTIC_CHECK_CONFIRMATION
      ? "CHECK"
      : confirmation === TARGETED_GMAIL_MIME_DIAGNOSTIC_RUN_CONFIRMATION
        ? "RUN"
        : null
  if (!mode) {
    return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")
  }

  const companyId = (env[GMAIL_MIME_DIAGNOSTIC_COMPANY_ENV] ?? "").trim()
  const messageId = (env[GMAIL_MIME_DIAGNOSTIC_MESSAGE_ENV] ?? "").trim()
  if (!companyId || !messageId) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/message non configurée")
  }

  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  const loadMessageTarget = deps.loadMessageTarget ?? defaultLoadMessageTarget
  let target: GmailMimeDiagnosticMessageTarget | null
  try {
    target = await loadMessageTarget(companyId, messageId)
  } catch {
    return refused(500, "MESSAGE_LOAD_FAILED", "Lecture du message cible impossible")
  }
  if (!target || target.id !== messageId || target.companyId !== companyId) {
    return refused(404, "MESSAGE_NOT_FOUND", "AcquisitionMessage cible introuvable pour ce tenant")
  }

  const externalMessageId = (target.externalMessageId ?? "").trim()
  const sourceMailboxKey = (target.sourceMailboxKey ?? "").trim()
  if (!externalMessageId) {
    return refused(409, "EXTERNAL_MESSAGE_ID_MISSING", "externalMessageId absent")
  }
  if (!sourceMailboxKey) {
    return refused(409, "SOURCE_MAILBOX_KEY_MISSING", "sourceMailboxKey absent")
  }

  if (mode === "CHECK") {
    return ok({
      mode: "CHECK",
      checks: {
        surfaceAllowed: true,
        flagEnabled: true,
        authorized: true,
        tenantMatch: true,
        targetConfigured: true,
        messageFound: true,
        externalMessageIdPresent: true,
        sourceMailboxKeyPresent: true,
      },
      tokenAcquired: false,
      gmailCalled: false,
    })
  }

  // RUN — token jamais logué, jamais retourné, jamais inclus dans une erreur.
  const getValidAccessToken = deps.getValidAccessToken ?? defaultGetValidAccessToken
  const getMessage = deps.getMessage ?? defaultGetMessage

  let accessToken: string
  try {
    accessToken = await getValidAccessToken({ companyId, connectionId: sourceMailboxKey })
  } catch (err) {
    return refused(502, "GMAIL_TOKEN_UNAVAILABLE", "Token Gmail Acquisition indisponible", {
      providerCode: safeProviderCode(err),
    })
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return refused(502, "GMAIL_TOKEN_UNAVAILABLE", "Token Gmail Acquisition indisponible", {
      providerCode: null,
    })
  }

  let message: GmailMessageResource
  try {
    message = await getMessage(accessToken, externalMessageId)
  } catch (err) {
    return refused(502, "GMAIL_MESSAGE_FETCH_FAILED", "Lecture Gmail du message impossible", {
      providerCode: safeProviderCode(err),
    })
  }

  if (!message || typeof message !== "object" || message.id !== externalMessageId) {
    return refused(502, "GMAIL_MESSAGE_IDENTITY_MISMATCH", "Message Gmail retourné ≠ cible")
  }

  const { parts, truncated } = extractImageMimeParts(message.payload)
  return ok({
    mode: "RUN",
    imagePartCount: parts.length,
    truncated,
    imageParts: parts,
  })
}
