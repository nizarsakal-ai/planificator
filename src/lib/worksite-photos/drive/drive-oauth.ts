/**
 * Photos d'engins — flux OAuth Google Drive (SPEC-WORKSITE-PHOTOS-001 §6.3, §7.5 ; ADR-PLAN-005 §1, D16).
 * Handlers testables (deps injectées) ; les routes Next sont des wrappers fins.
 *
 * - Démarrage : autorité administrateur relue en base (compte, entreprise, rôle effectif), drapeau actif, nonce
 *   cryptographique posé dans un cookie `HttpOnly` lié au navigateur, `state` signé HMAC portant l'empreinte du nonce,
 *   l'entreprise, l'auteur et une échéance (10 min) ; scopes `drive.file` + `userinfo.email`, `offline`, `consent`.
 * - Callback : state signé, non expiré, empreinte égale au cookie du navigateur, session courante = auteur et entreprise
 *   du state ; consommation à USAGE UNIQUE côté serveur (verrou consultatif + journal) AVANT tout échange de code ;
 *   échange réseau HORS transaction ; persistance dans une transaction qui relit l'autorité sous verrous `FOR SHARE`.
 * - Déconnexion : POST, origine contrôlée, autorité relue sous verrous, **locale** (aucune révocation Google), journalisée.
 * Le parcours se fait depuis un navigateur (Paramètres) : la coque Capacitor n'est pas prise en charge, Google refusant
 * l'OAuth dans une WebView embarquée. Aucun jeton, code, nonce ou URL signée n'est journalisé ni renvoyé.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { assertMutationOrigin } from "@/lib/http/request-origin"
import { HttpGuardError } from "@/lib/http/guard-error"
import { resolveGmailOAuthHmacSecret, signGmailOAuthPayload, verifyGmailOAuthSignature } from "@/lib/auth/gmail-oauth-state"
import { isWorksitePhotosEnabled } from "../feature-flag"
import { sanitizeEventDetail } from "../photo.domain"
import { disconnectDriveLocally, storeDriveConnection, type DriveConnectionDb } from "./drive-connection.client"
import type { FetchLike } from "./drive-api.client"

export const DRIVE_SCOPE_FILE = "https://www.googleapis.com/auth/drive.file"
const SCOPE_EMAIL = "https://www.googleapis.com/auth/userinfo.email"
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo"
const PRIVATE_HEADERS: Record<string, string> = { "Cache-Control": "private, no-store", Vary: "Cookie" }
/** Cookie de corrélation du navigateur initiateur ; restreint au chemin du flux. */
export const DRIVE_OAUTH_COOKIE = "wp_drive_oauth"
const COOKIE_PATH = "/api/auth/drive"
/** Durée de validité d'un state (et du cookie associé). */
export const DRIVE_OAUTH_STATE_TTL_SECONDS = 600
/** Tolérance d'horloge sur l'émission (state « venu du futur » refusé au-delà). */
const CLOCK_SKEW_MS = 60_000
const CONSUMED_ACTION = "DRIVE_OAUTH_STATE_CONSUMED"

export interface DriveOAuthSession { user?: { id?: string | null; role?: string | null; companyId?: string | null } | null }

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Lecture de l'autorité administrateur (compte, entreprise, fiche) et écritures du flux ; partagée client / transaction. */
export interface DriveOAuthTx extends DriveConnectionDb {
  $queryRaw: (query: TemplateStringsArray, ...values: any[]) => Promise<unknown>
  worksitePhotoEvent: { create: (args?: any) => Promise<unknown> }
  user: { findFirst: (args?: any) => Promise<{ id: string; role: string; companyId: string | null; active: boolean } | null> }
  company: { findFirst: (args?: any) => Promise<{ id: string; active: boolean } | null> }
  employee: { findFirst: (args?: any) => Promise<{ id: string; role: string; active: boolean } | null> }
}
export interface DriveOAuthDb extends DriveOAuthTx {
  $transaction: <T>(fn: (tx: DriveOAuthTx) => Promise<T>, options?: any) => Promise<T>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface DriveOAuthDeps {
  auth: () => Promise<DriveOAuthSession | null>
  db: DriveOAuthDb
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  clock?: () => Date
  crypto?: { encrypt: (plain: string) => string; decrypt: (cipher: string) => string }
  /** Source du nonce (32 octets aléatoires par défaut). */
  randomNonce?: () => string
}

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])
const TX_OPTIONS = { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 }

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } })
}

function appUrl(env: NodeJS.ProcessEnv): string {
  return (env.NEXTAUTH_URL ?? env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}

function cookieAttributes(env: NodeJS.ProcessEnv, maxAge: number): string {
  const secure = appUrl(env).startsWith("https://") ? "; Secure" : ""
  return `Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function clearCookieHeader(env: NodeJS.ProcessEnv): string {
  return `${DRIVE_OAUTH_COOKIE}=; ${cookieAttributes(env, 0)}`
}

/** Toute fin de callback efface le cookie de corrélation : un state ne sert qu'une fois, même en échec. */
function redirectToSettings(env: NodeJS.ProcessEnv, params: Record<string, string>): Response {
  const url = new URL("/parametres", appUrl(env))
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Response(null, { status: 302, headers: { ...PRIVATE_HEADERS, Location: url.toString(), "Set-Cookie": clearCookieHeader(env) } })
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=") || null
  }
  return null
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")

function sameHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
}

// ─── Autorité administrateur (L2-R2) ─────────────────────────────────────────

export type DriveAdminDecision = { ok: true; userId: string; companyId: string; role: string } | { ok: false; status: 401 | 403; code: "UNAUTHENTICATED" | "FORBIDDEN" }

/**
 * Autorité courante : compte actif, entreprise active, rôle effectif administrateur ÉGAL au rôle de session.
 * Rôle effectif : SUPER_ADMIN global ; sinon la fiche employé de l'entreprise fait foi (active) ; sinon le compte lui-même
 * s'il appartient à l'entreprise (administrateurs historiques). Avec `lock`, les lignes sont verrouillées `FOR SHARE` avant lecture.
 */
export async function resolveDriveAdmin(db: DriveOAuthTx, identity: { userId: string; companyId: string; sessionRole: string }, options: { lock?: boolean } = {}): Promise<DriveAdminDecision> {
  if (options.lock) {
    await db.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${identity.userId} FOR SHARE`
    await db.$queryRaw`SELECT "id" FROM "companies" WHERE "id" = ${identity.companyId} FOR SHARE`
    await db.$queryRaw`SELECT "id" FROM "employees" WHERE "userId" = ${identity.userId} AND "companyId" = ${identity.companyId} FOR SHARE`
  }
  const [actor, company, employee] = await Promise.all([
    db.user.findFirst({ where: { id: identity.userId }, select: { id: true, role: true, companyId: true, active: true } }),
    db.company.findFirst({ where: { id: identity.companyId }, select: { id: true, active: true } }),
    db.employee.findFirst({ where: { userId: identity.userId, companyId: identity.companyId }, select: { id: true, role: true, active: true } }),
  ])
  if (!actor?.active) return { ok: false, status: 401, code: "UNAUTHENTICATED" }
  if (!company?.active) return { ok: false, status: 403, code: "FORBIDDEN" }
  const effectiveRole = actor.role === "SUPER_ADMIN" ? "SUPER_ADMIN"
    : employee ? (employee.active ? employee.role : null)
      : actor.companyId === identity.companyId ? actor.role : null
  if (!effectiveRole || !ADMIN_ROLES.has(effectiveRole) || effectiveRole !== identity.sessionRole) return { ok: false, status: 403, code: "FORBIDDEN" }
  return { ok: true, userId: actor.id, companyId: identity.companyId, role: effectiveRole }
}

function sessionIdentity(session: DriveOAuthSession | null): { userId: string; companyId: string; sessionRole: string } | "unauthenticated" | "forbidden" {
  const user = session?.user
  if (!user?.id) return "unauthenticated"
  if (!ADMIN_ROLES.has(user.role ?? "") || !user.companyId?.trim()) return "forbidden"
  return { userId: user.id, companyId: user.companyId.trim(), sessionRole: user.role! }
}

// ─── State signé et corrélé au navigateur (L2-R1) ────────────────────────────

export interface DriveOAuthStatePayload { companyId: string; userId: string; nonceHash: string; iat: number; exp: number }

export function buildDriveAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId, redirect_uri: input.redirectUri, response_type: "code",
    scope: `${DRIVE_SCOPE_FILE} ${SCOPE_EMAIL}`, access_type: "offline", prompt: "consent", state: input.state,
  })
  return `${AUTH_URL}?${params}`
}

export function encodeDriveOAuthState(payload: DriveOAuthStatePayload, secret: string): string {
  const raw = JSON.stringify({ kind: "drive", v: 2, ...payload })
  return Buffer.from(JSON.stringify({ payload: raw, sig: signGmailOAuthPayload(raw, secret) })).toString("base64url")
}

/** Signature, type, version et forme ; l'échéance est contrôlée par l'appelant (horloge injectable). */
export function decodeDriveOAuthState(state: string, secret: string): DriveOAuthStatePayload | null {
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { payload?: unknown; sig?: unknown }
    if (typeof decoded.payload !== "string" || typeof decoded.sig !== "string" || !verifyGmailOAuthSignature(decoded.payload, decoded.sig, secret)) return null
    const p = JSON.parse(decoded.payload) as Record<string, unknown>
    if (p.kind !== "drive" || p.v !== 2) return null
    if (typeof p.companyId !== "string" || !p.companyId || typeof p.userId !== "string" || !p.userId) return null
    if (typeof p.nonceHash !== "string" || !/^[0-9a-f]{64}$/.test(p.nonceHash)) return null
    if (typeof p.iat !== "number" || typeof p.exp !== "number" || !Number.isFinite(p.iat) || !Number.isFinite(p.exp) || p.exp <= p.iat) return null
    return { companyId: p.companyId, userId: p.userId, nonceHash: p.nonceHash, iat: p.iat, exp: p.exp }
  } catch {
    return null
  }
}

/**
 * Consommation à usage unique, dans une transaction : verrou consultatif sur l'empreinte du nonce, puis absence d'un
 * événement `DRIVE_OAUTH_STATE_CONSUMED` portant cette empreinte, puis insertion de cet événement. Deux callbacks
 * concurrents sur le même state sont sérialisés : un seul passe.
 */
async function consumeState(tx: DriveOAuthTx, state: DriveOAuthStatePayload): Promise<boolean> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wp-drive-oauth:${state.nonceHash}`}, 0))::text AS "locked"`
  const existing = await tx.$queryRaw`SELECT 1 AS "found" FROM "worksite_photo_events"
    WHERE "companyId" = ${state.companyId} AND "action" = ${CONSUMED_ACTION} AND "detail"->>'nonceHash' = ${state.nonceHash} LIMIT 1` as unknown[]
  if (existing.length > 0) return false
  await tx.worksitePhotoEvent.create({ data: {
    companyId: state.companyId, action: CONSUMED_ACTION, actorKind: "USER", actorId: state.userId, actorNameSnapshot: state.userId, outcome: "DONE",
    detail: sanitizeEventDetail({ nonceHash: state.nonceHash }),
  } })
  return true
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /api/auth/drive — redirige l'administrateur vers Google. */
export async function handleDriveConnectStart(_request: Request, deps: DriveOAuthDeps): Promise<Response> {
  const env = deps.env ?? process.env
  const clock = deps.clock ?? (() => new Date())
  if (!isWorksitePhotosEnabled(env)) return json({ code: "FEATURE_DISABLED", error: "Introuvable" }, 404)
  const identity = sessionIdentity(await deps.auth())
  if (identity === "unauthenticated") return json({ code: "UNAUTHENTICATED", error: "Non autorisé" }, 401)
  if (identity === "forbidden") return json({ code: "FORBIDDEN", error: "Accès refusé" }, 403)
  const authority = await resolveDriveAdmin(deps.db, identity)
  if (!authority.ok) return json({ code: authority.code, error: authority.status === 401 ? "Non autorisé" : "Accès refusé" }, authority.status)
  const secret = resolveGmailOAuthHmacSecret(env)
  const clientId = env.GOOGLE_CLIENT_ID, redirectUri = env.DRIVE_OAUTH_REDIRECT_URI
  if (!secret || !clientId || !redirectUri) return json({ code: "OAUTH_NOT_CONFIGURED", error: "OAuth Google non configuré" }, 500)
  const nonce = (deps.randomNonce ?? (() => randomBytes(32).toString("base64url")))()
  const iat = clock().getTime()
  const state = encodeDriveOAuthState({ companyId: authority.companyId, userId: authority.userId, nonceHash: sha256Hex(nonce), iat, exp: iat + DRIVE_OAUTH_STATE_TTL_SECONDS * 1000 }, secret)
  return new Response(null, { status: 302, headers: {
    ...PRIVATE_HEADERS,
    Location: buildDriveAuthorizationUrl({ clientId, redirectUri, state }),
    "Set-Cookie": `${DRIVE_OAUTH_COOKIE}=${nonce}; ${cookieAttributes(env, DRIVE_OAUTH_STATE_TTL_SECONDS)}`,
  } })
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }

/** GET /api/auth/drive/callback — corrèle et consomme le state, échange le code, relit l'autorité, stocke chiffré. */
export async function handleDriveOAuthCallback(request: Request, deps: DriveOAuthDeps): Promise<Response> {
  const env = deps.env ?? process.env
  const clock = deps.clock ?? (() => new Date())
  const fetchImpl = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init))
  if (!isWorksitePhotosEnabled(env)) return json({ code: "FEATURE_DISABLED", error: "Introuvable" }, 404, { "Set-Cookie": clearCookieHeader(env) })
  const url = new URL(request.url)
  const code = url.searchParams.get("code"), stateParam = url.searchParams.get("state"), error = url.searchParams.get("error")
  if (error) return redirectToSettings(env, { drive: "error", reason: error.replace(/[^a-z_]/gi, "").slice(0, 40) || "denied" })
  if (!code || !stateParam) return redirectToSettings(env, { drive: "error", reason: "missing_params" })
  const secret = resolveGmailOAuthHmacSecret(env)
  const state = secret ? decodeDriveOAuthState(stateParam, secret) : null
  if (!state) return redirectToSettings(env, { drive: "error", reason: "invalid_state" })
  const now = clock().getTime()
  if (now > state.exp || state.iat > now + CLOCK_SKEW_MS) return redirectToSettings(env, { drive: "error", reason: "expired_state" })
  // Navigateur initiateur : le cookie de corrélation doit correspondre à l'empreinte signée.
  const nonce = readCookie(request, DRIVE_OAUTH_COOKIE)
  if (!nonce || !sameHex(sha256Hex(nonce), state.nonceHash)) return redirectToSettings(env, { drive: "error", reason: "browser_mismatch" })
  // Session courante : même auteur, même entreprise que le state (le cookie de session NextAuth suit la redirection de premier niveau).
  const session = sessionIdentity(await deps.auth())
  if (session === "unauthenticated" || session === "forbidden" || session.userId !== state.userId || session.companyId !== state.companyId) {
    return redirectToSettings(env, { drive: "error", reason: "session_mismatch" })
  }
  const clientId = env.GOOGLE_CLIENT_ID, clientSecret = env.GOOGLE_CLIENT_SECRET, redirectUri = env.DRIVE_OAUTH_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) return redirectToSettings(env, { drive: "error", reason: "not_configured" })

  // Autorité relue sous verrous ET consommation du state, AVANT tout échange de code.
  const admission = await deps.db.$transaction(async (tx) => {
    const authority = await resolveDriveAdmin(tx, session, { lock: true })
    if (!authority.ok) return "forbidden" as const
    return (await consumeState(tx, state)) ? "ok" as const : "replayed" as const
  }, TX_OPTIONS)
  if (admission === "forbidden") return redirectToSettings(env, { drive: "error", reason: "forbidden" })
  if (admission === "replayed") return redirectToSettings(env, { drive: "error", reason: "invalid_state" })

  // Échange réseau HORS transaction.
  let tokens: TokenResponse = {}
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    })
    tokens = (await response.json()) as TokenResponse
  } catch {
    return redirectToSettings(env, { drive: "error", reason: "token_exchange_failed" })
  }
  if (!tokens.access_token || !tokens.refresh_token) return redirectToSettings(env, { drive: "error", reason: "no_tokens" })
  if (!(tokens.scope ?? "").split(/\s+/).includes(DRIVE_SCOPE_FILE)) return redirectToSettings(env, { drive: "error", reason: "scope_missing" })
  let accountEmail = ""
  try {
    const profile = (await (await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).json()) as { email?: unknown }
    if (typeof profile.email === "string") accountEmail = profile.email.trim().toLowerCase()
  } catch { /* adresse facultative : la connexion reste utilisable */ }

  // Persistance : autorité RELUE sous verrous (une révocation pendant l'échange l'emporte), puis écriture et journal.
  const persisted = await deps.db.$transaction(async (tx) => {
    const authority = await resolveDriveAdmin(tx, session, { lock: true })
    if (!authority.ok) return false
    await storeDriveConnection({
      companyId: state.companyId, accountEmail, accessToken: tokens.access_token!, refreshToken: tokens.refresh_token!,
      expiresInSeconds: tokens.expires_in ?? 3600, connectedById: authority.userId,
    }, { db: tx, clock: deps.clock, crypto: deps.crypto, env })
    await tx.worksitePhotoEvent.create({ data: {
      companyId: state.companyId, action: "DRIVE_CONNECTED", actorKind: "USER", actorId: authority.userId, actorNameSnapshot: authority.userId, outcome: "DONE",
      detail: sanitizeEventDetail({ accountEmail: accountEmail || null }),
    } })
    return true
  }, TX_OPTIONS)
  if (!persisted) return redirectToSettings(env, { drive: "error", reason: "forbidden" })
  return redirectToSettings(env, { drive: "connected" })
}

/** POST /api/worksite-photos/drive/disconnect — déconnexion locale (aucune révocation Google, Gmail intact). */
export async function handleDriveDisconnect(request: Request, deps: DriveOAuthDeps): Promise<Response> {
  const env = deps.env ?? process.env
  if (!isWorksitePhotosEnabled(env)) return json({ code: "FEATURE_DISABLED", error: "Introuvable" }, 404)
  const identity = sessionIdentity(await deps.auth())
  if (identity === "unauthenticated") return json({ code: "UNAUTHENTICATED", error: "Non autorisé" }, 401)
  if (identity === "forbidden") return json({ code: "FORBIDDEN", error: "Accès refusé" }, 403)
  try { assertMutationOrigin(request, "INVALID_ORIGIN", env) } catch (error) {
    if (error instanceof HttpGuardError) return json({ code: error.code, error: "Accès refusé" }, error.status)
    throw error
  }
  // Autorité relue sous verrous dans la même transaction que l'effacement : un administrateur révoqué n'efface rien.
  const result = await deps.db.$transaction(async (tx) => {
    const authority = await resolveDriveAdmin(tx, identity, { lock: true })
    if (!authority.ok) return authority
    const changed = await disconnectDriveLocally(authority.companyId, { db: tx, clock: deps.clock, env })
    if (changed) {
      await tx.worksitePhotoEvent.create({ data: {
        companyId: authority.companyId, action: "DRIVE_DISCONNECTED", actorKind: "USER", actorId: authority.userId, actorNameSnapshot: authority.userId, outcome: "DONE", detail: { local: true, revokedAtGoogle: false },
      } })
    }
    return { ok: true as const, changed }
  }, TX_OPTIONS)
  if (!result.ok) return json({ code: result.code, error: result.status === 401 ? "Non autorisé" : "Accès refusé" }, result.status)
  return json({ status: "DISCONNECTED", changed: result.changed }, 200)
}
