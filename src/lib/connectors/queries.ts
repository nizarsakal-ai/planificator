/**
 * Lot F Planificator V2 : lectures du centre de connecteurs, bornées par `companyId`. Aucune lecture ne sélectionne
 * de référence d'identifiants ni de configuration : pour la plateforme d'intégration existante, seuls le type, le nom
 * et les trois états sont lus (jamais `credentialsRef`, `config` ni `watermark`).
 */
import type { PrismaClient } from "@prisma/client"
import { CONNECTORS, type ConnectorDefinition, type ConnectorKey } from "@/lib/connectors/catalog"

type Db = PrismaClient

export interface ConnectorRunView {
  id: string; status: "SUCCEEDED" | "FAILED"; startedAt: Date; finishedAt: Date
  received: number; created: number; updated: number; unchanged: number; errorCode: string | null
}
export interface ConnectorView {
  def: ConnectorDefinition
  mode: "DISABLED" | "SIMULATION" | "LIVE"
  changedAt: Date | null
  hasWatermark: boolean
  staged: Record<string, number>
  runs: ConnectorRunView[]
}
export interface PlatformConnectionView { id: string; connectorType: string; displayName: string; status: string; credentialStatus: string; runtimeHealth: string; lastSuccessfulRunAt: Date | null }

export async function loadConnectorCenter(db: Db, companyId: string): Promise<{ connectors: ConnectorView[]; platform: PlatformConnectionView[] }> {
  const [settings, runs, staged, platform] = await Promise.all([
    db.connectorSetting.findMany({ where: { companyId }, select: { connectorKey: true, mode: true, changedAt: true, watermark: true } }),
    db.connectorSyncRun.findMany({
      where: { companyId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 120,
      select: { id: true, connectorKey: true, status: true, startedAt: true, finishedAt: true, received: true, created: true, updated: true, unchanged: true, errorCode: true },
    }),
    db.connectorStagedRecord.groupBy({ by: ["connectorKey", "resource"], where: { companyId }, _count: { _all: true } }),
    db.integrationConnection.findMany({
      where: { companyId }, orderBy: [{ connectorType: "asc" }, { id: "asc" }], take: 50,
      select: { id: true, connectorType: true, displayName: true, status: true, credentialStatus: true, runtimeHealth: true, lastSuccessfulRunAt: true },
    }),
  ])
  const connectors = CONNECTORS.map((def): ConnectorView => {
    const s = settings.find((x) => x.connectorKey === def.key)
    const st: Record<string, number> = {}
    for (const r of def.resources) st[r.key] = staged.find((g) => g.connectorKey === def.key && g.resource === r.key)?._count._all ?? 0
    return {
      def, mode: s?.mode ?? "DISABLED", changedAt: s?.changedAt ?? null, hasWatermark: !!s?.watermark, staged: st,
      runs: runs.filter((r) => r.connectorKey === def.key).slice(0, 5),
    }
  })
  return { connectors, platform }
}

export async function listStagedRecords(db: Db, companyId: string, key: ConnectorKey, take = 20) {
  return db.connectorStagedRecord.findMany({
    where: { companyId, connectorKey: key }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take,
    select: { id: true, resource: true, externalId: true, version: true, payload: true, updatedAt: true },
  })
}
