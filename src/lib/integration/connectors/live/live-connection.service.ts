/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : identifiants des connexions RÉELLES (Shopify, Mailchimp, Slack).
 *
 * Enregistrement (§9.1) : saisie validée → connexion de plateforme PLATFORM_ENCRYPTED (créée une fois, liée une fois
 * au réglage du connecteur) → secret chiffré en version PENDING → vérification par une lecture minimale, HORS
 * transaction → ACTIVE si le service accepte, FAILED sinon. Une version ACTIVE antérieure reste en service tant que la
 * nouvelle n'est pas vérifiée (aucune coupure). Le secret n'est jamais renvoyé, journalisé, ni réaffiché : seul
 * l'indice (4 derniers caractères) est montré.
 * Révocation (§9.3) : le connecteur repasse « désactivé » s'il était en connexion réelle, la version ACTIVE est
 * révoquée et la connexion désactivée.
 */
import type { PrismaClient } from "@prisma/client"
import { CONNECTOR_ERRORS, LIVE_CONNECTOR_KEYS, SYNC_ERROR_LABEL, isLiveConnectorKey, isOAuthLiveKey, toErrorCode, type LiveConnectorKey } from "@/lib/connectors/connectors.core"
import { revokeGoogleCalendarRemotely, type TokenPost } from "@/lib/integration/connectors/oauth/google-calendar-oauth"
import { linkConnectorConnection, readConnectorSetting, setConnectorMode, type ConnectorContext, type ConnectorResult } from "@/lib/connectors/connectors.service"
import { parseLiveCredentials } from "@/lib/integration/connectors/live/live-catalog"
import { checkCredentialAttemptLimit } from "@/lib/integration/connectors/live/live-rate-limits"
import { nativeFetch, type FetchLike } from "@/lib/integration/connectors/live/live-http"
import { createLiveSource } from "@/lib/integration/connectors/live/live-sources"
import { activateCredential, assignCredentialsRef, failCredential, revokeCredential, storeCredential, type SecretProviderDeps } from "@/lib/integration/persistence/secret-provider.service"
import { SecretProviderError } from "@/lib/integration/secrets/secret-errors"

type Db = PrismaClient
export interface LiveDeps { fetch?: FetchLike; secrets?: SecretProviderDeps; now?: () => Date; sleep?: (ms: number) => Promise<void>; tokenPost?: TokenPost; env?: Record<string, string | undefined> }

export const LIVE_ERRORS = {
  vaultUnavailable: "Le coffre à secrets n'est pas configuré sur ce serveur : enregistrement impossible.",
  notConfigured: "Aucun identifiant enregistré pour ce service.",
} as const

const DISPLAY_NAME: Record<LiveConnectorKey, string> = { shopify: "Shopify (lecture seule)", mailchimp: "Mailchimp (lecture seule)", slack: "Slack (lecture seule)", google_calendar: "Google Agenda (lecture seule)" }

/** Connexion de plateforme du connecteur : créée une fois, liée une fois au réglage (aussi utilisée par l'OAuth, LOT-8C). */
export async function ensureLiveConnection(db: Db, ctx: ConnectorContext, key: LiveConnectorKey, config: Record<string, string>, now: Date): Promise<ConnectorResult<string>> {
  return ensureConnection(db, ctx, key, config, now)
}

async function ensureConnection(db: Db, ctx: ConnectorContext, key: LiveConnectorKey, config: Record<string, string>, now: Date): Promise<ConnectorResult<string>> {
  const s = await readConnectorSetting(db, ctx, key)
  if (s?.connectionId) return { ok: true, value: s.connectionId }
  const c = await db.integrationConnection.create({
    data: { companyId: ctx.companyId, connectorType: key, displayName: DISPLAY_NAME[key], status: "PENDING_AUTH", secretBackend: "PLATFORM_ENCRYPTED", config },
    select: { id: true },
  })
  const linked = await linkConnectorConnection(db, ctx, key, c.id, now)
  if (!linked.ok) {
    // Course perdue : une autre requête a lié sa propre connexion ; la nôtre, vide, est archivée.
    await db.integrationConnection.updateMany({ where: { id: c.id, companyId: ctx.companyId }, data: { status: "ARCHIVED" } })
    const again = await readConnectorSetting(db, ctx, key)
    return again?.connectionId ? { ok: true, value: again.connectionId } : linked
  }
  return { ok: true, value: c.id }
}

/** Enregistre et vérifie des identifiants ; renvoie l'indice du secret actif, jamais le secret. */
export async function configureLiveConnector(db: Db, ctx: ConnectorContext, rawKey: string, form: Record<string, string | undefined>, d: LiveDeps = {}): Promise<ConnectorResult<{ hint: string | null }>> {
  if (!isLiveConnectorKey(rawKey)) return { ok: false, error: CONNECTOR_ERRORS.notFound }
  const key = rawKey
  const parsed = parseLiveCredentials(key, form)
  if (!parsed.ok) return parsed
  const now = (d.now ?? (() => new Date()))()
  const conn = await ensureConnection(db, ctx, key, parsed.config, now)
  if (!conn.ok) return conn
  const connectionId = conn.value
  // LOT-8D (§25) : verrou après refus répétés du service, et volume d'enregistrements borné par connexion.
  const limited = await checkCredentialAttemptLimit(db, ctx, connectionId, now)
  if (limited) return { ok: false, error: limited }
  let stored: { versionId: string; hint: string | null }
  try {
    await assignCredentialsRef(db, { companyId: ctx.companyId, connectionId })
    stored = await storeCredential(db, { companyId: ctx.companyId, connectionId, secretKind: "API_KEY", plaintext: parsed.secret, actorId: ctx.userId }, d.secrets)
  } catch (e) {
    if (e instanceof SecretProviderError) return { ok: false, error: e.code === "SECURITY_CONFIGURATION_INVALID" ? LIVE_ERRORS.vaultUnavailable : SYNC_ERROR_LABEL.REAL_CONNECTION_DISABLED }
    throw e
  }
  // Vérification réseau HORS transaction : aucune ligne verrouillée pendant l'appel au service.
  try {
    await createLiveSource(key, parsed.secret, parsed.config, d.fetch ?? nativeFetch).probe()
  } catch (e) {
    const code = toErrorCode(e)
    await failCredential(db, { companyId: ctx.companyId, connectionId, versionId: stored.versionId, actorId: ctx.userId, reasonCode: code }, d.secrets)
    return { ok: false, error: SYNC_ERROR_LABEL[code] }
  }
  await activateCredential(db, { companyId: ctx.companyId, connectionId, versionId: stored.versionId, actorId: ctx.userId }, d.secrets)
  await db.integrationConnection.update({ where: { id_companyId: { id: connectionId, companyId: ctx.companyId } }, data: { status: "ACTIVE", config: parsed.config, lastHealthCheckAt: now, lastStableErrorCode: null } })
  return { ok: true, value: { hint: stored.hint } }
}

/** Révoque les identifiants : connecteur désactivé s'il était en connexion réelle, version active révoquée. */
export async function revokeLiveConnector(db: Db, ctx: ConnectorContext, rawKey: string, d: LiveDeps = {}): Promise<ConnectorResult> {
  if (!isLiveConnectorKey(rawKey)) return { ok: false, error: CONNECTOR_ERRORS.notFound }
  const s = await readConnectorSetting(db, ctx, rawKey)
  if (!s?.connectionId) return { ok: false, error: LIVE_ERRORS.notConfigured }
  if (s.mode === "LIVE") {
    const r = await setConnectorMode(db, ctx, rawKey, "DISABLED", (d.now ?? (() => new Date()))())
    if (!r.ok) return r
  }
  // LOT-8C : pour Google Agenda, l'autorisation est aussi retirée chez Google, au mieux, AVANT la révocation locale.
  if (isOAuthLiveKey(rawKey)) await revokeGoogleCalendarRemotely(db, ctx, s.connectionId, { post: d.tokenPost, secrets: d.secrets })
  try {
    await revokeCredential(db, { companyId: ctx.companyId, connectionId: s.connectionId, actorId: ctx.userId, reasonCode: "ADMIN_REVOKED" }, d.secrets)
  } catch (e) {
    if (e instanceof SecretProviderError) return { ok: false, error: LIVE_ERRORS.notConfigured }
    throw e
  }
  await db.integrationConnection.update({ where: { id_companyId: { id: s.connectionId, companyId: ctx.companyId } }, data: { status: "DISABLED" } })
  return { ok: true, value: undefined }
}

export interface LiveStatus { key: LiveConnectorKey; configured: boolean; usable: boolean; credentialStatus: string | null; hint: string | null; config: Record<string, string> }

/** État des identifiants par service, pour l'affichage : jamais de secret, seulement l'indice et la config non secrète. */
export async function loadLiveStatus(db: Db, companyId: string): Promise<Record<LiveConnectorKey, LiveStatus>> {
  const settings = await db.connectorSetting.findMany({
    where: { companyId, connectorKey: { in: [...LIVE_CONNECTOR_KEYS] }, connectionId: { not: null } },
    select: { connectorKey: true, connection: { select: { status: true, credentialStatus: true, secretBackend: true, config: true, credentialVersions: { where: { status: "ACTIVE" }, select: { hint: true }, take: 1 } } } },
  })
  const out = {} as Record<LiveConnectorKey, LiveStatus>
  for (const key of LIVE_CONNECTOR_KEYS) out[key] = { key, configured: false, usable: false, credentialStatus: null, hint: null, config: {} }
  for (const s of settings) {
    if (!isLiveConnectorKey(s.connectorKey) || !s.connection) continue
    const c = s.connection
    const config: Record<string, string> = {}
    if (c.config && typeof c.config === "object" && !Array.isArray(c.config)) for (const [k, v] of Object.entries(c.config)) if (typeof v === "string") config[k] = v
    out[s.connectorKey] = {
      key: s.connectorKey,
      configured: true,
      usable: c.secretBackend === "PLATFORM_ENCRYPTED" && c.status === "ACTIVE" && c.credentialStatus === "ACTIVE",
      credentialStatus: c.credentialStatus,
      hint: c.credentialVersions[0]?.hint ?? null,
      config,
    }
  }
  return out
}
