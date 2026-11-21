/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : synchronisation RÉELLE en lecture seule.
 *
 * 1. Réglage lu sans verrou : mode LIVE et connexion liée exigés.
 * 2. Secret résolu par le coffre pour l'appelant technique `connector-runtime` (§12), jamais conservé au-delà de l'appel.
 * 3. Pages lues HORS transaction (au plus MAX_PAGES_PER_RESOURCE × PAGE_SIZE éléments par ressource).
 * 4. Écriture tout ou rien par `commitFetchedSync`, qui revérifie sous verrou le mode et le curseur lus en 1.
 * Tout échec est journalisé avec un code stable ; le message du service distant n'est jamais conservé.
 * Correctif du 22/11/2026 (SECURITY-SPEC §25) : au plus une synchronisation réelle par minute et par connecteur, échecs
 * compris (une limite 429 ne se relance pas en boucle) ; un refus pour délai n'est pas journalisé et ne touche à rien.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { connectorByKey } from "@/lib/connectors/catalog"
import { CONNECTOR_ERRORS, MAX_PAGES_PER_RESOURCE, SYNC_ERROR_LABEL, isLiveConnectorKey, parseWatermark, toErrorCode, type SourceItem, type SyncErrorCode } from "@/lib/connectors/connectors.core"
import { commitFetchedSync, readConnectorSetting, recordFailedSync, type ConnectorContext, type ConnectorResult, type FetchedResource, type SyncSummary } from "@/lib/connectors/connectors.service"
import { readLiveConfig } from "@/lib/integration/connectors/live/live-catalog"
import { nativeFetch } from "@/lib/integration/connectors/live/live-http"
import { createLiveSource } from "@/lib/integration/connectors/live/live-sources"
import type { LiveDeps } from "@/lib/integration/connectors/live/live-connection.service"
import { resolveCredential } from "@/lib/integration/persistence/secret-provider.service"
import { resolveSecretEnvironment } from "@/lib/integration/secrets/keyring"
import { SecretProviderError } from "@/lib/integration/secrets/secret-errors"

type Db = PrismaClient
export const LIVE_SYNC_COOLDOWN_MS = 60_000

const secretFailure = (e: SecretProviderError): SyncErrorCode => (e.code === "CONNECTION_AUTH_REVOKED" ? "AUTH_FAILED" : "REAL_CONNECTION_DISABLED")

export async function runLiveConnectorSync(db: Db, ctx: ConnectorContext, rawKey: string, d: LiveDeps = {}): Promise<ConnectorResult<SyncSummary>> {
  if (!isLiveConnectorKey(rawKey)) return { ok: false, error: CONNECTOR_ERRORS.notFound }
  const key = rawKey, def = connectorByKey(key)
  const clock = d.now ?? (() => new Date())
  const s = await readConnectorSetting(db, ctx, key)
  if (!s || s.mode !== "LIVE" || !s.connectionId) return { ok: false, error: CONNECTOR_ERRORS.notLive }
  const runId = randomUUID()
  const startedAt = clock()
  const recent = await db.connectorSyncRun.findFirst({ where: { companyId: ctx.companyId, connectorKey: key, mode: "LIVE", startedAt: { gt: new Date(startedAt.getTime() - LIVE_SYNC_COOLDOWN_MS) } }, select: { id: true } })
  if (recent) return { ok: false, error: CONNECTOR_ERRORS.liveCooldown }
  const failWith = async (code: SyncErrorCode): Promise<ConnectorResult<SyncSummary>> => {
    await recordFailedSync(db, ctx, key, "LIVE", code, startedAt, runId, clock)
    await db.integrationConnection.updateMany({ where: { id: s.connectionId!, companyId: ctx.companyId }, data: { lastFailedRunAt: clock(), lastStableErrorCode: code } })
    return { ok: false, error: SYNC_ERROR_LABEL[code] }
  }

  const conn = await db.integrationConnection.findFirst({ where: { id: s.connectionId, companyId: ctx.companyId, connectorType: key }, select: { config: true } })
  const config = conn ? readLiveConfig(key, conn.config) : null
  if (!config) return failWith("REAL_CONNECTION_DISABLED")

  let secret: string
  try {
    secret = await resolveCredential(db, { companyId: ctx.companyId, connectionId: s.connectionId, secretKind: "API_KEY", runtimeCallerId: "connector-runtime", environment: d.secrets?.environment ?? resolveSecretEnvironment() }, d.secrets)
  } catch (e) {
    if (e instanceof SecretProviderError) return failWith(secretFailure(e))
    throw e
  }

  const resources: FetchedResource[] = []
  try {
    const wm = parseWatermark(def, s.watermark)
    const source = createLiveSource(key, secret, config, d.fetch ?? nativeFetch, { sleep: d.sleep })
    for (const r of def.resources) {
      let cursor: string | null = wm[r.key] ?? null
      const items: SourceItem[] = []
      for (let page = 0; page < MAX_PAGES_PER_RESOURCE; page++) {
        const p = await source.fetchPage(r.key, cursor)
        items.push(...p.items)
        cursor = p.cursor
        if (!p.hasMore) break
      }
      resources.push({ key: r.key, items, cursor })
    }
  } catch (e) {
    return failWith(toErrorCode(e))
  }

  const result = await commitFetchedSync(db, ctx, key, { runId, startedAt, watermarkBefore: s.watermark, resources }, { now: clock })
  if (result.ok) await db.integrationConnection.updateMany({ where: { id: s.connectionId, companyId: ctx.companyId }, data: { lastSuccessfulRunAt: clock(), lastStableErrorCode: null } })
  return result
}
