/**
 * Photos d'engins — connexion Drive de l'entreprise (SPEC-WORKSITE-PHOTOS-001 §3.5, §7.5 ; ADR-PLAN-005 §1, D16).
 *
 * Tokens OAuth chiffrés AES-256-GCM (`src/lib/encryption.ts`, même clé que Gmail), refresh côté serveur avec marge,
 * `invalid_grant` ⇒ connexion en `ERROR` (révocation globale, mot de passe changé) ; déconnexion **locale** uniquement
 * (jamais d'appel au point de révocation Google : le client OAuth est partagé avec Gmail).
 *
 * Génération de connexion (L2-R3) : le chiffré du refresh token sert de jeton de génération. Le chiffrement tire un IV
 * aléatoire, donc toute reconnexion (nouveau chiffré) ou déconnexion (chiffré effacé) invalide la génération lue.
 * Le résultat d'un refresh et toute mise en ERROR sont publiés par CAS sur cette génération : un refresh de l'ancienne
 * connexion ne peut ni écraser la nouvelle, ni la mettre en erreur, ni réécrire un jeton après déconnexion.
 * Surface base structurelle (patron `BookingAgentDb`) pour des tests sans Prisma ; aucun secret journalisé.
 */
import { decrypt as defaultDecrypt, encrypt as defaultEncrypt } from "@/lib/encryption"
import { DriveProviderError } from "./drive.errors"
import type { FetchLike } from "./drive-api.client"

export type DriveConnectionStatus = "ACTIVE" | "ERROR" | "DISCONNECTED"

export interface DriveConnectionRecord {
  id: string
  companyId: string
  accountEmail: string
  accessToken: string
  refreshToken: string
  tokenExpiry: Date
  rootFolderId: string | null
  status: DriveConnectionStatus
  lastErrorCode: string | null
  lastErrorAt: Date | null
  connectedById: string
  connectedAt: Date
  disconnectedAt: Date | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface DriveConnectionDb {
  worksitePhotoDriveConnection: {
    findUnique: (args?: any) => Promise<DriveConnectionRecord | null>
    update: (args?: any) => Promise<unknown>
    /** CAS : nombre de lignes modifiées (0 = génération périmée). */
    updateMany: (args?: any) => Promise<{ count: number }>
    upsert: (args?: any) => Promise<unknown>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface DriveConnectionDeps {
  db: DriveConnectionDb
  fetchImpl?: FetchLike
  env?: NodeJS.ProcessEnv
  clock?: () => Date
  crypto?: { encrypt: (plain: string) => string; decrypt: (cipher: string) => string }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const EXPIRY_MARGIN_MS = 5 * 60_000
/** Valeur sentinelle des colonnes NOT NULL après déconnexion locale (jamais déchiffrée). */
const CLEARED_TOKEN = ""

function resolve(deps: DriveConnectionDeps) {
  return {
    db: deps.db,
    fetchImpl: deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init)),
    env: deps.env ?? process.env,
    clock: deps.clock ?? (() => new Date()),
    crypto: deps.crypto ?? { encrypt: defaultEncrypt, decrypt: defaultDecrypt },
  }
}

export async function findDriveConnection(companyId: string, deps: DriveConnectionDeps): Promise<DriveConnectionRecord | null> {
  if (!companyId) return null
  return deps.db.worksitePhotoDriveConnection.findUnique({ where: { companyId } })
}

/** Connexion prouvée utilisable : le prédicat n'affirme que ce qu'il vérifie (ACTIVE), une connexion ERROR ou DISCONNECTED reste lisible ailleurs. */
export type UsableDriveConnection = DriveConnectionRecord & { status: "ACTIVE" }

/** Connexion utilisable : présente, ACTIVE, tokens non effacés. */
export function isDriveConnectionUsable(connection: DriveConnectionRecord | null): connection is UsableDriveConnection {
  return !!connection && connection.status === "ACTIVE" && connection.refreshToken !== CLEARED_TOKEN
}

/** Condition CAS de la génération lue : même entreprise, même chiffré de refresh token, toujours ACTIVE. */
function generationOf(connection: DriveConnectionRecord) {
  return { companyId: connection.companyId, refreshToken: connection.refreshToken, status: "ACTIVE" as const }
}

/** Met en ERROR la génération lue seulement (une reconnexion ou une déconnexion intervenue entre-temps l'emporte). */
export async function markDriveConnectionError(connection: DriveConnectionRecord, code: string, deps: DriveConnectionDeps): Promise<boolean> {
  const { db, clock } = resolve(deps)
  const { count } = await db.worksitePhotoDriveConnection.updateMany({
    where: generationOf(connection),
    data: { status: "ERROR", lastErrorCode: code.slice(0, 64), lastErrorAt: clock() },
  })
  return count === 1
}

/** Trace un incident technique sans changer le statut (configuration, protocole) : la connexion n'est pas condamnée. */
async function noteDriveConnectionIncident(connection: DriveConnectionRecord, code: string, deps: DriveConnectionDeps): Promise<void> {
  const { db, clock } = resolve(deps)
  await db.worksitePhotoDriveConnection.updateMany({ where: generationOf(connection), data: { lastErrorCode: code.slice(0, 64), lastErrorAt: clock() } })
}

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string; scope?: string }

/**
 * Classement des refus du point de jeton (L2-R4), selon le code OAuth renvoyé (RFC 6749 §5.2) :
 * - `invalid_grant` seul condamne la connexion (révocation, consentement expiré) : ERROR, reconnexion requise ;
 * - `invalid_client`, `unauthorized_client` : configuration du client OAuth, non réessayable, statut inchangé ;
 * - `invalid_request`, `unsupported_grant_type`, `invalid_scope`, autre 4xx ou réponse illisible : protocole, non réessayable, statut inchangé ;
 * - 429 et 5xx : indisponibilité réessayable.
 */
type TokenRefusal = { kind: "revoked" } | { kind: "misconfigured" } | { kind: "protocol" } | { kind: "unavailable" }
export function classifyTokenRefusal(httpStatus: number, oauthError: string | null): TokenRefusal {
  if (oauthError === "invalid_grant") return { kind: "revoked" }
  if (httpStatus === 429 || httpStatus >= 500) return { kind: "unavailable" }
  if (oauthError === "invalid_client" || oauthError === "unauthorized_client") return { kind: "misconfigured" }
  return { kind: "protocol" }
}

async function refreshAccessToken(connection: DriveConnectionRecord, deps: DriveConnectionDeps): Promise<string> {
  const { db, fetchImpl, env, clock, crypto } = resolve(deps)
  const clientId = env.GOOGLE_CLIENT_ID, clientSecret = env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new DriveProviderError("DRIVE_NOT_CONNECTED", 503, false, null, "oauth_not_configured")
  let refreshToken: string
  try { refreshToken = crypto.decrypt(connection.refreshToken) } catch {
    await markDriveConnectionError(connection, "refresh_token_undecryptable", deps)
    throw new DriveProviderError("DRIVE_NOT_CONNECTED", 503, false, null, "refresh_token_undecryptable")
  }
  let response: Response
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    })
  } catch {
    throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true, null, "token_endpoint_unreachable")
  }
  let data: TokenResponse = {}
  try { data = (await response.json()) as TokenResponse } catch { /* réponse illisible : classée « protocole » ci-dessous */ }
  if (!response.ok || !data.access_token) {
    const oauthError = typeof data.error === "string" ? data.error.replace(/[^a-z_]/gi, "").slice(0, 40) : null
    const refusal = response.ok ? { kind: "protocol" as const } : classifyTokenRefusal(response.status, oauthError)
    if (refusal.kind === "revoked") {
      await markDriveConnectionError(connection, "invalid_grant", deps)
      throw new DriveProviderError("DRIVE_NOT_CONNECTED", 503, false, response.status, "invalid_grant")
    }
    if (refusal.kind === "unavailable") throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true, response.status, oauthError)
    const code = refusal.kind === "misconfigured" ? "DRIVE_OAUTH_MISCONFIGURED" : "DRIVE_OAUTH_PROTOCOL_ERROR"
    await noteDriveConnectionIncident(connection, oauthError ?? `http_${response.status}`, deps)
    throw new DriveProviderError(code, refusal.kind === "misconfigured" ? 500 : 502, false, response.status, oauthError)
  }
  const expiry = new Date(clock().getTime() + (data.expires_in ?? 3600) * 1000)
  // Publication par CAS sur la génération lue : si la connexion a changé pendant l'appel, le jeton obtenu est jeté.
  const { count } = await db.worksitePhotoDriveConnection.updateMany({
    where: generationOf(connection),
    data: { accessToken: crypto.encrypt(data.access_token), tokenExpiry: expiry, lastErrorCode: null, lastErrorAt: null },
  })
  if (count === 1) return data.access_token
  // CAS perdu = la génération a changé pendant l'appel (reconnexion, déconnexion, mise en erreur). Le jeton obtenu
  // appartient à l'ancienne génération : il est jeté. Seul le jeton de la connexion COURANTE peut être rendu, s'il est valide.
  const current = await findDriveConnection(connection.companyId, deps)
  if (isDriveConnectionUsable(current) && current.tokenExpiry.getTime() >= clock().getTime() + EXPIRY_MARGIN_MS) {
    try { return crypto.decrypt(current.accessToken) } catch { /* illisible : refus ci-dessous */ }
  }
  const usable = isDriveConnectionUsable(current)
  throw new DriveProviderError(usable ? "DRIVE_UNAVAILABLE" : "DRIVE_NOT_CONNECTED", 503, usable, null, "connection_changed_during_refresh")
}

/** Jeton d'accès valide (refresh si expiration proche ou si `force`). Jamais renvoyé au client HTTP. */
export async function getValidDriveAccessToken(companyId: string, deps: DriveConnectionDeps, options: { force?: boolean } = {}): Promise<string> {
  const { clock, crypto } = resolve(deps)
  const connection = await findDriveConnection(companyId, deps)
  if (!isDriveConnectionUsable(connection)) throw new DriveProviderError("DRIVE_NOT_CONNECTED", 503, false, null, connection ? connection.status.toLowerCase() : "absent")
  const expiringSoon = connection.tokenExpiry.getTime() < clock().getTime() + EXPIRY_MARGIN_MS
  if (!options.force && !expiringSoon) {
    try { return crypto.decrypt(connection.accessToken) } catch { /* jeton illisible : on rafraîchit */ }
  }
  return refreshAccessToken(connection, deps)
}

/** Exécute un appel Drive ; un 401 du fournisseur déclenche un seul refresh forcé puis une nouvelle tentative. */
export async function withDriveAccess<T>(companyId: string, deps: DriveConnectionDeps, fn: (accessToken: string) => Promise<T>): Promise<T> {
  const token = await getValidDriveAccessToken(companyId, deps)
  try {
    return await fn(token)
  } catch (error) {
    if (error instanceof DriveProviderError && error.code === "DRIVE_UNAUTHORIZED") {
      const refreshed = await getValidDriveAccessToken(companyId, deps, { force: true })
      return fn(refreshed)
    }
    throw error
  }
}

export interface StoreDriveConnectionInput {
  companyId: string
  accountEmail: string
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  connectedById: string
}

/** Après un échange de code OAuth réussi : tokens chiffrés, statut ACTIVE, erreurs effacées, dossier racine conservé. */
export async function storeDriveConnection(input: StoreDriveConnectionInput, deps: DriveConnectionDeps): Promise<void> {
  const { db, clock, crypto } = resolve(deps)
  const now = clock()
  const expiry = new Date(now.getTime() + Math.max(60, input.expiresInSeconds) * 1000)
  const encrypted = { accessToken: crypto.encrypt(input.accessToken), refreshToken: crypto.encrypt(input.refreshToken) }
  await db.worksitePhotoDriveConnection.upsert({
    where: { companyId: input.companyId },
    create: {
      companyId: input.companyId, accountEmail: input.accountEmail, ...encrypted, tokenExpiry: expiry,
      status: "ACTIVE", connectedById: input.connectedById, connectedAt: now,
    },
    update: {
      accountEmail: input.accountEmail, ...encrypted, tokenExpiry: expiry,
      status: "ACTIVE", lastErrorCode: null, lastErrorAt: null, connectedById: input.connectedById, connectedAt: now, disconnectedAt: null,
    },
  })
}

/**
 * Déconnexion LOCALE (D16) : tokens effacés, statut DISCONNECTED, aucun appel réseau, aucune écriture sur les
 * connexions Gmail. La révocation complète se fait dans les paramètres du compte Google et couperait aussi Gmail.
 */
export async function disconnectDriveLocally(companyId: string, deps: DriveConnectionDeps): Promise<boolean> {
  const { db, clock } = resolve(deps)
  const connection = await findDriveConnection(companyId, deps)
  if (!connection || connection.status === "DISCONNECTED") return false
  await db.worksitePhotoDriveConnection.update({
    where: { companyId },
    data: { accessToken: CLEARED_TOKEN, refreshToken: CLEARED_TOKEN, status: "DISCONNECTED", disconnectedAt: clock(), lastErrorCode: null, lastErrorAt: null },
  })
  return true
}
