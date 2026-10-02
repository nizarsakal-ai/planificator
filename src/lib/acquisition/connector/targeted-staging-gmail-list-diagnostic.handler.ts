/**
 * Harness temporaire Staging Preview — diagnostic Gmail messages.list (cas Penven).
 * Compare un jeu FIXE de requêtes progressivement restrictives pour localiser où messages.list
 * cesse de retrouver le message. Fail-closed. Cible via env uniquement.
 *
 * CHECK : gardes + connexion cible active. Aucun token, aucun appel Gmail, aucune écriture.
 * RUN   : getValidAccessToken({ companyId, connectionId }) (mécanisme normal, refresh OAuth normal
 *         possible : accessToken / tokenExpiry), puis UNIQUEMENT messages.list pour les 4 requêtes
 *         fixes (maxResults borné, une page, aucun pageToken). Aucun getMessage / getAttachment /
 *         getProfile / listHistory, aucune ingestion, aucun curseur.
 * Sortie : par requête, nombre d'IDs retournés, resultSizeEstimate, présence d'une page suivante et
 *          au plus quelques IDs Gmail opaques (même convention que INSPECT du harness de sync).
 *          Jamais de token, de réponse brute, de message d'erreur brut ni de contenu de message.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { FetchGmailApiClient, type GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

export const TARGETED_GMAIL_LIST_DIAGNOSTIC_CHECK_CONFIRMATION = "CHECK_TARGETED_STAGING_GMAIL_LIST_DIAGNOSTIC" as const
export const TARGETED_GMAIL_LIST_DIAGNOSTIC_RUN_CONFIRMATION = "RUN_TARGETED_STAGING_GMAIL_LIST_DIAGNOSTIC" as const

/** planificator-staging (Preview only). */
export const GMAIL_LIST_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const GMAIL_LIST_DIAGNOSTIC_ENABLED_FLAG = "TARGETED_STAGING_GMAIL_LIST_DIAGNOSTIC_ENABLED"
/** Cible : mêmes variables que les harnesses Gmail ciblés (même connexion). */
export const GMAIL_LIST_DIAGNOSTIC_COMPANY_ENV = "TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID"
export const GMAIL_LIST_DIAGNOSTIC_CONNECTION_ENV = "TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID"

/** Page Gmail strictement bornée par requête. */
export const GMAIL_LIST_DIAGNOSTIC_MAX_RESULTS = 5
/** IDs Gmail opaques exposés au plus par requête. */
export const GMAIL_LIST_DIAGNOSTIC_MAX_IDS = 5

/**
 * Jeu FIXE de requêtes, codé côté serveur, progressivement restrictif. Jamais paramétrable.
 * D = requête exacte observée pour le RUN du harness Penven.
 */
export const GMAIL_LIST_DIAGNOSTIC_QUERIES = Object.freeze([
  Object.freeze({ key: "senderOnly", query: "from:jeanlaurentcazala@lauralu.fr" }),
  Object.freeze({ key: "senderAfter", query: "after:2026/09/25 from:jeanlaurentcazala@lauralu.fr" }),
  Object.freeze({ key: "senderSubject", query: "from:jeanlaurentcazala@lauralu.fr subject:Consultation" }),
  Object.freeze({
    key: "exactHarnessQuery",
    query: "after:2026/09/25 from:jeanlaurentcazala@lauralu.fr subject:Consultation",
  }),
] as const)

export type GmailListDiagnosticQueryKey = (typeof GMAIL_LIST_DIAGNOSTIC_QUERIES)[number]["key"]

export type GmailListDiagnosticSummary = {
  returnedCount: number
  resultSizeEstimate: number | null
  hasNextPage: boolean
  messageIds: string[]
}

const HARNESS = "targeted-staging-gmail-list-diagnostic"

/** Seule clé acceptée dans le body. */
const ALLOWED_BODY_KEYS = new Set(["confirmation"])

/** Clés de ciblage / recherche interdites, comparées après normalisation (minuscules, sans « _ » / « - »). */
const FORBIDDEN_TARGET_KEYS = new Set(
  [
    "companyId",
    "connectionId",
    "acquisitionGmailConnectionId",
    "gmailConnectionId",
    "mailboxKey",
    "sourceMailboxKey",
    "mailbox",
    "email",
    "emailAddress",
    "address",
    "query",
    "queries",
    "q",
    "search",
    "maxResults",
    "pageToken",
    "messageId",
    "accessToken",
    "token",
    "target",
  ].map(normalizeKey)
)

/** Codes provider exposables (jamais le message brut). */
const EXPOSABLE_PROVIDER_CODES = new Set<string>([
  "GMAIL_NOT_CONNECTED",
  "GMAIL_TOKEN_REFRESH_FAILED",
  "GMAIL_UNAUTHORIZED",
  "GMAIL_RATE_LIMITED",
  "GMAIL_UNAVAILABLE",
])

/** ID Gmail opaque : jeton alphanumérique court, sinon non exposé. */
const SAFE_GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/

export type GmailListDiagnosticSession = {
  user: { id: string; role: string; companyId: string | null }
} | null

export type GmailListDiagnosticConnection = { id: string; companyId: string; active: boolean }

/** Seule API Gmail autorisée : messages.list. */
export type GmailListReadClient = Pick<GmailApiClient, "listMessages">

export type TargetedGmailListDiagnosticHandlerDeps = {
  auth?: () => Promise<GmailListDiagnosticSession>
  env?: Record<string, string | undefined>
  loadConnection?: (input: { companyId: string; connectionId: string }) => Promise<GmailListDiagnosticConnection | null>
  getValidAccessToken?: (lookup: { companyId: string; connectionId: string }) => Promise<string>
  gmail?: GmailListReadClient
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isGmailListDiagnosticSurfaceAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "preview" && env.VERCEL_PROJECT_ID === GMAIL_LIST_DIAGNOSTIC_ALLOWED_VERCEL_PROJECT_ID
}

async function defaultLoadConnection(input: {
  companyId: string
  connectionId: string
}): Promise<GmailListDiagnosticConnection | null> {
  return prisma.acquisitionGmailConnection.findFirst({
    where: { id: input.connectionId, companyId: input.companyId },
    select: { id: true, companyId: true, active: true },
  })
}

function defaultGetValidAccessToken(lookup: { companyId: string; connectionId: string }): Promise<string> {
  return new PrismaAcquisitionGmailConnectionClient().getValidAccessToken(lookup)
}

function safeProviderCode(err: unknown): string | null {
  return err instanceof GmailProviderError && EXPOSABLE_PROVIDER_CODES.has(err.code) ? err.code : null
}

/** Synthèse sûre d'une page messages.list : compteurs + quelques IDs opaques, rien d'autre. */
export function summarizeListPage(page: unknown): GmailListDiagnosticSummary {
  const p = page && typeof page === "object" ? (page as Record<string, unknown>) : {}
  const messages = Array.isArray(p.messages) ? p.messages : []
  const ids = messages
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && SAFE_GMAIL_ID.test(id))
  const estimate = p.resultSizeEstimate
  return {
    returnedCount: messages.length,
    resultSizeEstimate: typeof estimate === "number" && Number.isFinite(estimate) ? estimate : null,
    hasNextPage: typeof p.nextPageToken === "string" && p.nextPageToken.length > 0,
    messageIds: [...new Set(ids)].slice(0, GMAIL_LIST_DIAGNOSTIC_MAX_IDS),
  }
}

function respond(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function refused(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return respond(status, { ok: false, code, message, ...extra })
}

export async function handleTargetedStagingGmailListDiagnostic(
  req: Request,
  deps: TargetedGmailListDiagnosticHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isGmailListDiagnosticSurfaceAllowed(env)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }
  if (env[GMAIL_LIST_DIAGNOSTIC_ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? (auth as unknown as () => Promise<GmailListDiagnosticSession>)
  let session: GmailListDiagnosticSession
  try {
    session = await authenticate()
  } catch {
    return refused(401, "UNAUTHORIZED", "Non authentifié")
  }
  if (!session?.user) return refused(401, "UNAUTHORIZED", "Non authentifié")
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
    return refused(400, "TARGET_OVERRIDE_FORBIDDEN", "La cible ne peut pas être fournie dans la requête")
  }
  if (keys.some((k) => !ALLOWED_BODY_KEYS.has(k))) {
    return refused(400, "UNKNOWN_FIELD", "Champ non autorisé dans la requête")
  }

  const confirmation = (body as { confirmation?: unknown }).confirmation
  const mode =
    confirmation === TARGETED_GMAIL_LIST_DIAGNOSTIC_CHECK_CONFIRMATION
      ? "CHECK"
      : confirmation === TARGETED_GMAIL_LIST_DIAGNOSTIC_RUN_CONFIRMATION
        ? "RUN"
        : null
  if (!mode) return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")

  const companyId = (env[GMAIL_LIST_DIAGNOSTIC_COMPANY_ENV] ?? "").trim()
  const connectionId = (env[GMAIL_LIST_DIAGNOSTIC_CONNECTION_ENV] ?? "").trim()
  if (!companyId || !connectionId) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/connexion non configurée")
  }
  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  const loadConnection = deps.loadConnection ?? defaultLoadConnection
  let connection: GmailListDiagnosticConnection | null
  try {
    connection = await loadConnection({ companyId, connectionId })
  } catch {
    return refused(500, "CONNECTION_LOAD_FAILED", "Lecture de la connexion cible impossible")
  }
  if (!connection || connection.id !== connectionId || connection.companyId !== companyId) {
    return refused(404, "CONNECTION_NOT_FOUND", "Connexion Gmail Acquisition cible introuvable pour ce tenant")
  }
  if (connection.active !== true) {
    return refused(409, "CONNECTION_INACTIVE", "Connexion Gmail Acquisition cible inactive")
  }

  if (mode === "CHECK") {
    return respond(200, { ok: true, harness: HARNESS, mode: "CHECK", tokenCalled: false, gmailCalled: false })
  }

  // ---- RUN ---- token via le mécanisme normal ; jamais logué, retourné ni inclus dans une erreur.
  const getValidAccessToken = deps.getValidAccessToken ?? defaultGetValidAccessToken
  const gmail = deps.gmail ?? new FetchGmailApiClient()

  let accessToken: string
  try {
    accessToken = await getValidAccessToken({ companyId, connectionId })
  } catch (err) {
    return refused(502, "GMAIL_TOKEN_UNAVAILABLE", "Token Gmail Acquisition indisponible", {
      providerCode: safeProviderCode(err),
      tokenCalled: true,
      gmailCalled: false,
    })
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return refused(502, "GMAIL_TOKEN_UNAVAILABLE", "Token Gmail Acquisition indisponible", {
      providerCode: null,
      tokenCalled: true,
      gmailCalled: false,
    })
  }

  // Requêtes fixes, dans l'ordre ; une page bornée chacune ; arrêt au premier échec (fail-closed).
  const queries: Partial<Record<GmailListDiagnosticQueryKey, GmailListDiagnosticSummary>> = {}
  for (const entry of GMAIL_LIST_DIAGNOSTIC_QUERIES) {
    let page: unknown
    try {
      page = await gmail.listMessages(accessToken, entry.query, GMAIL_LIST_DIAGNOSTIC_MAX_RESULTS)
    } catch (err) {
      return refused(502, "GMAIL_LIST_FAILED", "messages.list a échoué pour une requête de diagnostic", {
        failedQuery: entry.key,
        providerCode: safeProviderCode(err),
        tokenCalled: true,
        gmailCalled: true,
        queries,
      })
    }
    queries[entry.key] = summarizeListPage(page)
  }

  return respond(200, {
    ok: true,
    harness: HARNESS,
    mode: "RUN",
    tokenCalled: true,
    gmailCalled: true,
    maxResults: GMAIL_LIST_DIAGNOSTIC_MAX_RESULTS,
    queries,
  })
}
