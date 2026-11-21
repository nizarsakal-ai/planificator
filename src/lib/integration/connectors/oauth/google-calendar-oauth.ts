/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8C : OAuth Google Agenda en lecture seule (SECURITY-SPEC §10, §11, §12, §16.3, §24).
 *
 * Initiation (ADMIN de la société de session, drapeau CONNECTOR_LIVE_ENABLED) :
 * - `state` de 32 octets aléatoires, à usage unique, 10 minutes, lié à la société, à l'utilisateur et au connecteur ;
 *   seule son empreinte SHA-256 est stockée (table `integration_oauth_states`) ;
 * - cookie de corrélation du navigateur (HttpOnly, SameSite=Lax, chemin du flux) dont seule l'empreinte est stockée ;
 * - PKCE S256 ; portée minimale `calendar.readonly` ; `access_type=offline` + `prompt=consent` (refresh token) ;
 * - adresse de retour en liste fermée : une seule, dérivée de NEXTAUTH_URL.
 * Retour : `state` consommé atomiquement (une seule fois, non expiré, même société, même utilisateur, même navigateur)
 * AVANT l'échange du code ; échange hors transaction ; portée vérifiée ; refresh token chiffré dans le coffre
 * (`OAUTH_REFRESH_TOKEN`, PENDING → lecture de vérification → ACTIVE) ; jeton d'accès jamais stocké.
 * Rafraîchissement : par le runtime seulement, sérialisé par société + connexion (verrou consultatif PostgreSQL), sans
 * jamais remplacer un refresh token par une valeur vide.
 *
 * Client OAuth DÉDIÉ (`GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET`), distinct du client Gmail/Drive
 * (`GOOGLE_CLIENT_ID`) et distinct entre production et préproduction (§16.3). Aucun jeton, code, `state` ni vérificateur
 * n'est journalisé ni renvoyé ; les erreurs de Google deviennent des codes stables.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { ConnectorSourceError, SYNC_ERROR_LABEL, toErrorCode, type SyncErrorCode } from "@/lib/connectors/connectors.core"
import type { ConnectorContext } from "@/lib/connectors/connectors.service"
import { liveGetJson, nativeFetch, type FetchLike } from "@/lib/integration/connectors/live/live-http"
import {
  activateCredential, assignCredentialsRef, failCredential, resolveCredential, storeCredential, type SecretProviderDeps,
} from "@/lib/integration/persistence/secret-provider.service"
import { resolveSecretEnvironment } from "@/lib/integration/secrets/keyring"
import { SecretProviderError } from "@/lib/integration/secrets/secret-errors"

type Db = PrismaClient
type Env = Record<string, string | undefined>

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
const AUTH_HOST = "accounts.google.com"
const TOKEN_HOST = "oauth2.googleapis.com"
export const OAUTH_STATE_TTL_MS = 10 * 60_000
export const OAUTH_COOKIE = "gcal_oauth"
export const OAUTH_PATH = "/api/connecteurs/google-agenda"
export const CALLBACK_PATH = `${OAUTH_PATH}/callback`
const TOKEN_TIMEOUT_MS = 10_000
const TOKEN_MAX_BYTES = 64_000
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const

export const GOOGLE_OAUTH_MESSAGES = {
  connected: "Google Agenda connecté en lecture seule : l'autorisation est chiffrée dans le coffre à secrets. Choisissez « Utiliser la connexion réelle » pour synchroniser.",
  notConfigured: "Connexion Google Agenda indisponible : le client OAuth dédié n'est pas configuré sur ce serveur.",
  liveDisabled: "Connexion réelle désactivée sur ce serveur.",
  stateInvalid: "Lien de connexion expiré ou déjà utilisé : recommencez depuis le centre de connecteurs.",
  denied: "Connexion Google Agenda annulée : aucune autorisation n'a été donnée.",
  scope: "Autorisation insuffisante : cochez l'accès en lecture à Google Agenda lors de la connexion.",
  noRefreshToken: "Google n'a pas fourni d'autorisation durable : retirez Planificator des applications autorisées de votre compte Google, puis reconnectez-vous.",
  vault: "Le coffre à secrets n'est pas configuré sur ce serveur : connexion impossible.",
} as const

// ─── Configuration ───────────────────────────────────────────────────────────

export interface GoogleOAuthConfig { clientId: string; clientSecret: string; redirectUri: string }

/** Client OAuth dédié, ou `null` (connexion indisponible) : absent, égal au client Gmail/Drive, ou adresse non HTTPS en ligne. */
export function readGoogleCalendarOAuthConfig(env: Env = process.env): GoogleOAuthConfig | null {
  const clientId = (env.GOOGLE_CALENDAR_CLIENT_ID ?? "").trim()
  const clientSecret = (env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "").trim()
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret.length < 10) return null
  if (clientId === (env.GOOGLE_CLIENT_ID ?? "").trim()) return null // §16.3 : jamais le client Gmail/Drive
  let origin: URL
  try { origin = new URL((env.NEXTAUTH_URL ?? "").trim().replace(/\/+$/, "")) } catch { return null }
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1"
  if (origin.pathname !== "/" || origin.search || (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) return null
  if (env.VERCEL_ENV === "production" && local) return null
  return { clientId, clientSecret, redirectUri: `${origin.origin}${CALLBACK_PATH}` }
}

/** Pour l'écran : le bouton « Se connecter avec Google » n'apparaît que si le client dédié est configuré. */
export const isGoogleCalendarOAuthConfigured = (env: Env = process.env): boolean => readGoogleCalendarOAuthConfig(env) !== null

// ─── Aléa, empreintes, PKCE ──────────────────────────────────────────────────

const b64url = (b: Buffer) => b.toString("base64url")
export const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex")
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest())
function sameHex(a: string, b: string): boolean {
  return /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
}

// ─── Échanges avec le serveur de jetons (POST borné, hôte fixe) ──────────────

export interface TokenResponse { access_token?: unknown; refresh_token?: unknown; scope?: unknown; expires_in?: unknown; error?: unknown }
export type TokenPost = (host: string, path: string, form: Record<string, string>) => Promise<{ status: number; body: TokenResponse }>

/** POST de formulaire vers l'hôte de jetons Google FIXE : HTTPS, sans redirection, délai et taille bornés, sans cache. */
export const nativeTokenPost: TokenPost = async (host, path, form) => {
  if (host !== TOKEN_HOST || (path !== "/token" && path !== "/revoke")) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  let r: Response
  try {
    r = await fetch(`https://${host}${path}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString(),
      redirect: "manual", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    })
  } catch { throw new ConnectorSourceError("SOURCE_UNAVAILABLE") }
  const declared = Number(r.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > TOKEN_MAX_BYTES) { await r.body?.cancel().catch(() => undefined); throw new ConnectorSourceError("SOURCE_UNAVAILABLE") }
  const text = await r.text().catch(() => "")
  if (Buffer.byteLength(text, "utf8") > TOKEN_MAX_BYTES) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  let body: unknown = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = {} }
  return { status: r.status, body: body !== null && typeof body === "object" && !Array.isArray(body) ? (body as TokenResponse) : {} }
}

/** Statut Google ⇒ code stable : 400/401/403 (invalid_grant, invalid_client) ⇒ AUTH_FAILED, 429 ⇒ RATE_LIMITED. */
function tokenErrorCode(status: number): SyncErrorCode {
  if (status === 400 || status === 401 || status === 403) return "AUTH_FAILED"
  if (status === 429) return "RATE_LIMITED"
  return "SOURCE_UNAVAILABLE"
}
const isToken = (v: unknown): v is string => typeof v === "string" && v.length >= 10 && v.length <= 4096 && !/\s/.test(v)
export const hasCalendarScope = (scope: unknown) => typeof scope === "string" && scope.split(" ").includes(GOOGLE_CALENDAR_SCOPE)

export async function exchangeCode(post: TokenPost, cfg: GoogleOAuthConfig, code: string, verifier: string): Promise<{ accessToken: string; refreshToken: string | null; scope: unknown }> {
  const r = await post(TOKEN_HOST, "/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri })
  if (r.status < 200 || r.status >= 300) throw new ConnectorSourceError(tokenErrorCode(r.status))
  if (!isToken(r.body.access_token)) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  return { accessToken: r.body.access_token, refreshToken: isToken(r.body.refresh_token) ? r.body.refresh_token : null, scope: r.body.scope }
}

export async function refreshAccessToken(post: TokenPost, cfg: GoogleOAuthConfig, refreshToken: string): Promise<{ accessToken: string; newRefreshToken: string | null }> {
  const r = await post(TOKEN_HOST, "/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret })
  if (r.status < 200 || r.status >= 300) throw new ConnectorSourceError(tokenErrorCode(r.status))
  if (!isToken(r.body.access_token)) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
  if (r.body.scope !== undefined && !hasCalendarScope(r.body.scope)) throw new ConnectorSourceError("AUTH_FAILED")
  // Jamais de remplacement par une valeur vide : un nouveau refresh token n'est retenu que s'il est bien formé et différent.
  const fresh = isToken(r.body.refresh_token) && r.body.refresh_token !== refreshToken ? r.body.refresh_token : null
  return { accessToken: r.body.access_token, newRefreshToken: fresh }
}

/** Révocation côté Google, au mieux (la révocation locale du coffre est faite quoi qu'il arrive). */
export async function revokeAtGoogle(post: TokenPost, refreshToken: string): Promise<boolean> {
  try { return (await post(TOKEN_HOST, "/revoke", { token: refreshToken })).status === 200 } catch { return false }
}

// ─── États OAuth à usage unique ──────────────────────────────────────────────

export interface Rng { bytes(n: number): Buffer }
const defaultRng: Rng = { bytes: (n) => randomBytes(n) }

/** Crée un état (empreintes seulement) et renvoie l'adresse d'autorisation Google et le nonce du cookie. */
export async function startGoogleCalendarOAuth(db: Db, ctx: ConnectorContext, cfg: GoogleOAuthConfig, opts: { now?: Date; rng?: Rng } = {}): Promise<{ authUrl: string; browserNonce: string }> {
  const rng = opts.rng ?? defaultRng
  const now = opts.now ?? new Date()
  const state = b64url(rng.bytes(32)), browserNonce = b64url(rng.bytes(32)), verifier = b64url(rng.bytes(48))
  await db.integrationOAuthState.create({
    data: { companyId: ctx.companyId, userId: ctx.userId, connectorKey: "google_calendar", stateHash: sha256Hex(state), browserHash: sha256Hex(browserNonce), codeVerifier: verifier, createdAt: now, expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS) },
  })
  const u = new URL(`https://${AUTH_HOST}/o/oauth2/v2/auth`)
  for (const [k, v] of Object.entries({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: GOOGLE_CALENDAR_SCOPE, access_type: "offline", prompt: "consent",
    include_granted_scopes: "false", state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
  })) u.searchParams.set(k, v)
  return { authUrl: u.toString(), browserNonce }
}

/**
 * Consomme l'état en UNE requête atomique : non consommé, non expiré, même société, même utilisateur. Le navigateur est
 * ensuite comparé (empreinte du cookie). Renvoie le vérificateur PKCE (effacé en base au même instant) ou `null`.
 */
export async function consumeOAuthState(db: Db, ctx: ConnectorContext, input: { state: string; browserNonce: string | null }, now: Date = new Date()): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.state) || !input.browserNonce || !/^[A-Za-z0-9_-]{43}$/.test(input.browserNonce)) return null
  const rows = await db.$queryRaw<{ codeVerifier: string; browserHash: string }[]>`
    UPDATE "integration_oauth_states" AS t SET "consumedAt" = ${now}, "codeVerifier" = NULL
    FROM (SELECT "id", "codeVerifier", "browserHash" FROM "integration_oauth_states"
          WHERE "stateHash" = ${sha256Hex(input.state)} AND "consumedAt" IS NULL AND "expiresAt" > ${now}
            AND "companyId" = ${ctx.companyId} AND "userId" = ${ctx.userId} AND "connectorKey" = 'google_calendar'
          FOR UPDATE) AS old
    WHERE t."id" = old."id"
    RETURNING old."codeVerifier" AS "codeVerifier", old."browserHash" AS "browserHash"`
  const row = rows[0]
  if (!row || !sameHex(row.browserHash, sha256Hex(input.browserNonce))) return null
  return row.codeVerifier
}

// ─── Lecture de vérification (§9.1) ──────────────────────────────────────────

/** Lecture minimale avec le jeton d'accès candidat : identifiant de l'agenda principal. */
export async function probeCalendar(fetchImpl: FetchLike, accessToken: string): Promise<void> {
  await liveGetJson(fetchImpl, { host: "www.googleapis.com", path: "/calendar/v3/calendars/primary", query: { fields: "id" }, headers: { authorization: `Bearer ${accessToken}` } })
}

// ─── Retour : enregistrement dans le coffre ──────────────────────────────────

export interface CallbackDeps {
  post?: TokenPost; fetch?: FetchLike; secrets?: SecretProviderDeps; now?: () => Date
  ensureConnection: (config: Record<string, string>) => Promise<{ ok: true; value: string } | { ok: false; error: string }>
}

/** Retour Google : état, échange, portée, coffre. Renvoie un message à afficher (jamais un détail de Google). */
export async function completeGoogleCalendarOAuth(
  db: Db, ctx: ConnectorContext, cfg: GoogleOAuthConfig,
  input: { code: string | null; state: string | null; error: string | null; browserNonce: string | null },
  d: CallbackDeps,
): Promise<{ ok: boolean; message: string }> {
  const now = (d.now ?? (() => new Date()))()
  // L'état est consommé même si Google signale un refus : un lien ne sert qu'une fois.
  const verifier = input.state ? await consumeOAuthState(db, ctx, { state: input.state, browserNonce: input.browserNonce }, now) : null
  if (!verifier) return { ok: false, message: GOOGLE_OAUTH_MESSAGES.stateInvalid }
  if (input.error) return { ok: false, message: GOOGLE_OAUTH_MESSAGES.denied }
  if (!input.code || input.code.length > 2048 || /\s/.test(input.code)) return { ok: false, message: GOOGLE_OAUTH_MESSAGES.stateInvalid }
  const post = d.post ?? nativeTokenPost
  let tokens: Awaited<ReturnType<typeof exchangeCode>>
  try { tokens = await exchangeCode(post, cfg, input.code, verifier) } catch (e) { return { ok: false, message: SYNC_ERROR_LABEL[toErrorCode(e)] } }
  if (!hasCalendarScope(tokens.scope)) return { ok: false, message: GOOGLE_OAUTH_MESSAGES.scope }
  const conn = await d.ensureConnection({ calendarId: "primary" })
  if (!conn.ok) return { ok: false, message: conn.error }
  const connectionId = conn.value
  if (!tokens.refreshToken) {
    // §11 : pas de refresh token ⇒ état clair, reconnexion demandée ; rien n'est stocké.
    await db.integrationConnection.updateMany({ where: { id: connectionId, companyId: ctx.companyId, status: { not: "ACTIVE" } }, data: { status: "PENDING_AUTH", lastStableErrorCode: "AUTH_FAILED" } })
    return { ok: false, message: GOOGLE_OAUTH_MESSAGES.noRefreshToken }
  }
  let versionId: string
  try {
    await assignCredentialsRef(db, { companyId: ctx.companyId, connectionId })
    versionId = (await storeCredential(db, { companyId: ctx.companyId, connectionId, secretKind: "OAUTH_REFRESH_TOKEN", plaintext: tokens.refreshToken, actorId: ctx.userId }, d.secrets)).versionId
  } catch (e) {
    if (e instanceof SecretProviderError) return { ok: false, message: GOOGLE_OAUTH_MESSAGES.vault }
    throw e
  }
  try {
    await probeCalendar(d.fetch ?? nativeFetch, tokens.accessToken)
  } catch (e) {
    const code = toErrorCode(e)
    await failCredential(db, { companyId: ctx.companyId, connectionId, versionId, actorId: ctx.userId, reasonCode: code }, d.secrets)
    return { ok: false, message: SYNC_ERROR_LABEL[code] }
  }
  await activateCredential(db, { companyId: ctx.companyId, connectionId, versionId, actorId: ctx.userId }, d.secrets)
  await db.integrationConnection.update({ where: { id_companyId: { id: connectionId, companyId: ctx.companyId } }, data: { status: "ACTIVE", config: { calendarId: "primary" }, lastHealthCheckAt: now, lastStableErrorCode: null } })
  return { ok: true, message: GOOGLE_OAUTH_MESSAGES.connected }
}

// ─── Runtime : jeton d'accès éphémère, refresh sérialisé ─────────────────────

/**
 * Jeton d'accès pour UNE synchronisation, jamais stocké. Sous verrou consultatif transactionnel (société + connexion) :
 * deux rafraîchissements de la même connexion sont sérialisés ; un refresh token renouvelé par Google est enregistré en
 * nouvelle version (PENDING → ACTIVE), jamais remplacé par une valeur vide.
 */
export async function googleAccessTokenForSync(
  db: Db, ctx: ConnectorContext, connectionId: string, d: { post?: TokenPost; secrets?: SecretProviderDeps; env?: Env } = {},
): Promise<string> {
  const cfg = readGoogleCalendarOAuthConfig(d.env)
  if (!cfg) throw new ConnectorSourceError("REAL_CONNECTION_DISABLED")
  const post = d.post ?? nativeTokenPost
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gcal-refresh:${ctx.companyId}:${connectionId}`}, 0))`
    const refreshToken = await resolveCredential(db, { companyId: ctx.companyId, connectionId, secretKind: "OAUTH_REFRESH_TOKEN", runtimeCallerId: "connector-runtime", environment: d.secrets?.environment ?? resolveSecretEnvironment() }, d.secrets)
    const r = await refreshAccessToken(post, cfg, refreshToken)
    if (r.newRefreshToken) {
      const v = await storeCredential(db, { companyId: ctx.companyId, connectionId, secretKind: "OAUTH_REFRESH_TOKEN", plaintext: r.newRefreshToken, actorId: "connector-runtime" }, d.secrets)
      await activateCredential(db, { companyId: ctx.companyId, connectionId, versionId: v.versionId, actorId: "connector-runtime" }, d.secrets)
    }
    return r.accessToken
  }, { timeout: 25_000, maxWait: 10_000 })
}

/** Révocation Google au mieux, avant la révocation locale (appelant `revocation-service`, §12). */
export async function revokeGoogleCalendarRemotely(db: Db, ctx: ConnectorContext, connectionId: string, d: { post?: TokenPost; secrets?: SecretProviderDeps } = {}): Promise<boolean> {
  try {
    const token = await resolveCredential(db, { companyId: ctx.companyId, connectionId, secretKind: "OAUTH_REFRESH_TOKEN", runtimeCallerId: "revocation-service", environment: d.secrets?.environment ?? resolveSecretEnvironment() }, d.secrets)
    return await revokeAtGoogle(d.post ?? nativeTokenPost, token)
  } catch { return false }
}

// ─── Réponses HTTP des routes ────────────────────────────────────────────────

export function cookieHeader(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${OAUTH_COOKIE}=${value}; Path=${OAUTH_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`
}
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return rest.join("=") || null
  }
  return null
}
/** Retour vers le centre de connecteurs avec un message (ok ou erreur), cookie de corrélation effacé. */
export function backToConnectors(request: Request, ok: boolean, message: string): Response {
  const url = new URL("/connecteurs", request.url)
  url.searchParams.set(ok ? "ok" : "erreur", message)
  return new Response(null, { status: 302, headers: { ...PRIVATE_HEADERS, Location: url.toString(), "Set-Cookie": cookieHeader("", 0, url.protocol === "https:") } })
}
export function redirectToGoogle(authUrl: string, browserNonce: string, secure: boolean): Response {
  return new Response(null, { status: 302, headers: { ...PRIVATE_HEADERS, Location: authUrl, "Set-Cookie": cookieHeader(browserNonce, OAUTH_STATE_TTL_MS / 1000, secure) } })
}
