/**
 * Harness temporaire Staging Preview — diagnostic de l'IDENTITÉ OAuth de la connexion Gmail
 * Acquisition ciblée : quelle boîte correspond réellement au token ? Fail-closed. Cible via env uniquement.
 *
 * CHECK : gardes + connexion cible active. Aucun token, aucun appel Gmail, aucune écriture.
 * RUN   : getValidAccessToken({ companyId, connectionId }) (mécanisme normal, refresh OAuth normal
 *         possible : accessToken / tokenExpiry), puis UN SEUL getProfile (GET users/me/profile).
 *         Aucun messages.list / get / attachments / history, aucune ingestion, aucun curseur.
 * Sortie : emailAddress du profil uniquement. Jamais de token, de réponse brute ni de message d'erreur brut.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { FetchGmailApiClient, type GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

export const TARGETED_GMAIL_OAUTH_PROFILE_CHECK_CONFIRMATION = "CHECK_TARGETED_STAGING_GMAIL_OAUTH_PROFILE" as const
export const TARGETED_GMAIL_OAUTH_PROFILE_RUN_CONFIRMATION = "RUN_TARGETED_STAGING_GMAIL_OAUTH_PROFILE" as const

/** planificator-staging (Preview only). */
export const GMAIL_OAUTH_PROFILE_ALLOWED_VERCEL_PROJECT_ID = "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD"

export const GMAIL_OAUTH_PROFILE_ENABLED_FLAG = "TARGETED_STAGING_GMAIL_OAUTH_PROFILE_ENABLED"
/** Cible : mêmes variables que les harnesses de sync / ingestion ciblées (même connexion). */
export const GMAIL_OAUTH_PROFILE_COMPANY_ENV = "TARGETED_STAGING_GMAIL_SYNC_COMPANY_ID"
export const GMAIL_OAUTH_PROFILE_CONNECTION_ENV = "TARGETED_STAGING_GMAIL_SYNC_CONNECTION_ID"

const HARNESS = "targeted-staging-gmail-oauth-profile"
const MAX_EMAIL_LENGTH = 320

/** Seule clé acceptée dans le body. */
const ALLOWED_BODY_KEYS = new Set(["confirmation"])

/** Clés de ciblage interdites, comparées après normalisation (minuscules, sans « _ » / « - »). */
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
    "gmailAddress",
    "address",
    "userId",
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

export type GmailOAuthProfileSession = {
  user: { id: string; role: string; companyId: string | null }
} | null

export type GmailOAuthProfileConnection = { id: string; companyId: string; active: boolean }

/** Seule API Gmail autorisée : le profil. */
export type GmailProfileReadClient = Pick<GmailApiClient, "getProfile">

export type TargetedGmailOAuthProfileHandlerDeps = {
  auth?: () => Promise<GmailOAuthProfileSession>
  env?: Record<string, string | undefined>
  loadConnection?: (input: { companyId: string; connectionId: string }) => Promise<GmailOAuthProfileConnection | null>
  getValidAccessToken?: (lookup: { companyId: string; connectionId: string }) => Promise<string>
  gmail?: GmailProfileReadClient
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "")
}

/** Runtime fail-closed : uniquement Preview du projet Staging exact. */
export function isGmailOAuthProfileSurfaceAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "preview" && env.VERCEL_PROJECT_ID === GMAIL_OAUTH_PROFILE_ALLOWED_VERCEL_PROJECT_ID
}

async function defaultLoadConnection(input: {
  companyId: string
  connectionId: string
}): Promise<GmailOAuthProfileConnection | null> {
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

function respond(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function refused(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return respond(status, { ok: false, code, message, ...extra })
}

export async function handleTargetedStagingGmailOAuthProfile(
  req: Request,
  deps: TargetedGmailOAuthProfileHandlerDeps = {}
): Promise<Response> {
  const env = deps.env ?? process.env

  if (!isGmailOAuthProfileSurfaceAllowed(env)) {
    return refused(403, "HARNESS_SURFACE_FORBIDDEN", "Surface non autorisée pour ce harness")
  }
  if (env[GMAIL_OAUTH_PROFILE_ENABLED_FLAG] !== "true") {
    return refused(403, "HARNESS_DISABLED", "Harness désactivé")
  }

  const authenticate = deps.auth ?? (auth as unknown as () => Promise<GmailOAuthProfileSession>)
  let session: GmailOAuthProfileSession
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
    confirmation === TARGETED_GMAIL_OAUTH_PROFILE_CHECK_CONFIRMATION
      ? "CHECK"
      : confirmation === TARGETED_GMAIL_OAUTH_PROFILE_RUN_CONFIRMATION
        ? "RUN"
        : null
  if (!mode) return refused(400, "CONFIRMATION_REQUIRED", "Confirmation exacte requise")

  const companyId = (env[GMAIL_OAUTH_PROFILE_COMPANY_ENV] ?? "").trim()
  const connectionId = (env[GMAIL_OAUTH_PROFILE_CONNECTION_ENV] ?? "").trim()
  if (!companyId || !connectionId) {
    return refused(403, "HARNESS_TARGET_UNSET", "Cible company/connexion non configurée")
  }
  if (!session.user.companyId || session.user.companyId !== companyId) {
    return refused(403, "TENANT_MISMATCH", "companyId session ≠ cible harness")
  }

  const loadConnection = deps.loadConnection ?? defaultLoadConnection
  let connection: GmailOAuthProfileConnection | null
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
    return respond(200, { ok: true, harness: HARNESS, mode: "CHECK", gmailCalled: false, profileCalled: false })
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
      gmailCalled: false,
      profileCalled: false,
    })
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return refused(502, "GMAIL_TOKEN_UNAVAILABLE", "Token Gmail Acquisition indisponible", {
      providerCode: null,
      gmailCalled: false,
      profileCalled: false,
    })
  }

  let emailAddress: string
  try {
    const profile = await gmail.getProfile(accessToken)
    const raw = typeof profile?.emailAddress === "string" ? profile.emailAddress.trim() : ""
    if (!raw || raw.length > MAX_EMAIL_LENGTH || !raw.includes("@")) {
      return refused(502, "PROFILE_EMAIL_MISSING", "Profil Gmail sans adresse exploitable", {
        gmailCalled: true,
        profileCalled: true,
      })
    }
    emailAddress = raw
  } catch (err) {
    return refused(502, "GMAIL_PROFILE_FAILED", "Lecture du profil Gmail impossible", {
      providerCode: safeProviderCode(err),
      gmailCalled: true,
      profileCalled: true,
    })
  }

  return respond(200, {
    ok: true,
    harness: HARNESS,
    mode: "RUN",
    gmailCalled: true,
    profileCalled: true,
    emailAddress,
  })
}
