/**
 * Lot F Planificator V2 : service du centre de connecteurs. Toute lecture et écriture est bornée par `ctx.companyId`
 * (session). Aucun appel réseau : la synchronisation reçoit son transport en paramètre et le seul transport livré est
 * la simulation (double fictif). Les éléments reçus vont en zone de transit (`ConnectorStagedRecord`), jamais dans les
 * tables métier (devis, factures, clients) : leur intégration éventuelle relève du lot I, avec ses propres règles.
 *
 * Synchronisation : UNE transaction verrouille le réglage du connecteur (`SELECT … FOR UPDATE`, borné par companyId),
 * revérifie le mode SIMULATION, lit les pages depuis le curseur, enregistre chaque élément (créé, nouvelle version ou
 * inchangé selon son empreinte), inscrit l'exécution au journal et avance le curseur. Deux synchronisations du même
 * connecteur sont donc sérialisées et la seconde repart du curseur de la première : rien n'est compté deux fois. En
 * cas d'échec, tout est annulé (curseur compris) et un échec est journalisé à part avec un code stable seulement.
 */
import { randomUUID } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { serverNow } from "@/lib/billing/clock"
import { connectorByKey, isConnectorKey, type ConnectorKey } from "@/lib/connectors/catalog"
import {
  CONNECTOR_ERRORS, MAX_PAGES_PER_RESOURCE, PAGE_SIZE, SYNC_ERROR_LABEL, checkItem, decideUpsert, emptyCounts,
  parseWatermark, serializeWatermark, toErrorCode, type SyncCounts, type SyncErrorCode,
} from "@/lib/connectors/connectors.core"
import { simulationTransport, type ConnectorTransport } from "@/lib/connectors/transport"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface ConnectorContext { companyId: string; userId: string }
export type ConnectorResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }
const MODE_LABEL = { DISABLED: "désactivé", SIMULATION: "simulation (données fictives)" } as const

class ConnectorFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "ConnectorFailure" }
}
const fail = (m: string): never => { throw new ConnectorFailure(m) }

async function audit(tx: Tx, ctx: ConnectorContext, entityId: string, detail: string) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "ConnectorSetting", entityId, detail } })
}
async function lockSetting(tx: Tx, ctx: ConnectorContext, key: ConnectorKey) {
  const rows = await tx.$queryRaw<{ id: string; mode: string; watermark: string | null }[]>`
    SELECT "id", "mode"::text AS "mode", "watermark" FROM "connector_settings"
    WHERE "companyId" = ${ctx.companyId} AND "connectorKey" = ${key} FOR UPDATE`
  return rows[0] ?? null
}

/** Change le mode : DISABLED ⇄ SIMULATION seulement (aucun autre mode n'existe, en code comme en base). */
export async function setConnectorMode(db: Db, ctx: ConnectorContext, rawKey: string, rawMode: string, now: Date = serverNow()): Promise<ConnectorResult> {
  if (!isConnectorKey(rawKey)) return { ok: false, error: CONNECTOR_ERRORS.notFound }
  if (rawMode !== "DISABLED" && rawMode !== "SIMULATION") return { ok: false, error: CONNECTOR_ERRORS.mode }
  const key = rawKey, mode = rawMode
  try {
    await db.$transaction(async (tx) => {
      const s = await lockSetting(tx, ctx, key)
      if (s && s.mode === mode) fail(CONNECTOR_ERRORS.sameMode)
      if (!s && mode === "DISABLED") fail(CONNECTOR_ERRORS.sameMode)
      const id = s
        ? (await tx.connectorSetting.update({ where: { id: s.id }, data: { mode, changedById: ctx.userId, changedAt: now }, select: { id: true } })).id
        : (await tx.connectorSetting.create({ data: { companyId: ctx.companyId, connectorKey: key, mode, changedById: ctx.userId, changedAt: now }, select: { id: true } })).id
      await audit(tx, ctx, id, `Connecteur ${connectorByKey(key).label} : mode ${MODE_LABEL[mode]}`)
    })
    return { ok: true, value: undefined }
  } catch (e) {
    if (e instanceof ConnectorFailure) return { ok: false, error: e.userMessage }
    // Création concurrente du même réglage : l'unicité (entreprise, connecteur) a refusé la seconde.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: CONNECTOR_ERRORS.changedMeanwhile }
    throw e
  }
}

/** Remet le curseur à zéro (simulation seulement) : la synchronisation suivante relit tout, sans rien dupliquer. */
export async function resetConnectorWatermark(db: Db, ctx: ConnectorContext, rawKey: string, now: Date = serverNow()): Promise<ConnectorResult> {
  if (!isConnectorKey(rawKey)) return { ok: false, error: CONNECTOR_ERRORS.notFound }
  const key = rawKey
  try {
    await db.$transaction(async (tx) => {
      const s = (await lockSetting(tx, ctx, key)) ?? fail(CONNECTOR_ERRORS.notSimulation)
      if (s.mode !== "SIMULATION") fail(CONNECTOR_ERRORS.notSimulation)
      await tx.connectorSetting.update({ where: { id: s.id }, data: { watermark: null, changedById: ctx.userId, changedAt: now } })
      await audit(tx, ctx, s.id, `Connecteur ${connectorByKey(key).label} : curseur de synchronisation réinitialisé`)
    })
    return { ok: true, value: undefined }
  } catch (e) {
    if (e instanceof ConnectorFailure) return { ok: false, error: e.userMessage }
    throw e
  }
}

export interface SyncSummary extends SyncCounts { runId: string; watermark: string | null }

/** Synchronisation simulée d'un connecteur (toutes ses ressources), tout ou rien. */
export async function runConnectorSync(
  db: Db, ctx: ConnectorContext, rawKey: string,
  opts: { transport?: ConnectorTransport; now?: () => Date } = {},
): Promise<ConnectorResult<SyncSummary>> {
  if (!isConnectorKey(rawKey)) return { ok: false, error: CONNECTOR_ERRORS.notFound }
  const key = rawKey, def = connectorByKey(key)
  const transport = opts.transport ?? simulationTransport
  const clock = opts.now ?? serverNow
  if (transport.kind !== "SIMULATION") return { ok: false, error: SYNC_ERROR_LABEL.REAL_CONNECTION_DISABLED }
  const startedAt = clock()
  const runId = randomUUID()
  try {
    const value = await db.$transaction(async (tx) => {
      const s = (await lockSetting(tx, ctx, key)) ?? fail(CONNECTOR_ERRORS.notSimulation)
      if (s.mode !== "SIMULATION") fail(CONNECTOR_ERRORS.notSimulation)
      const wm = parseWatermark(def, s.watermark)
      const counts = emptyCounts()
      for (const r of def.resources) {
        let cursor = wm[r.key] ?? null
        for (let page = 0; page < MAX_PAGES_PER_RESOURCE; page++) {
          const p = await transport.fetchPage({ connectorKey: key, resource: r.key, cursor, limit: PAGE_SIZE })
          const items = p.items.map(checkItem)
          const known = new Map((await tx.connectorStagedRecord.findMany({
            where: { companyId: ctx.companyId, connectorKey: key, resource: r.key, externalId: { in: items.map((i) => i.externalId) } },
            select: { id: true, externalId: true, payloadHash: true, version: true },
          })).map((k) => [k.externalId, k]))
          for (const it of items) {
            counts.received++
            const k = known.get(it.externalId)
            const d = decideUpsert(k?.payloadHash, it.hash)
            counts[d]++
            if (d === "created") {
              const c = await tx.connectorStagedRecord.create({ data: { companyId: ctx.companyId, connectorKey: key, resource: r.key, externalId: it.externalId, payload: it.data, payloadHash: it.hash, firstRunId: runId, lastRunId: runId }, select: { id: true } })
              known.set(it.externalId, { id: c.id, externalId: it.externalId, payloadHash: it.hash, version: 1 })
            } else if (d === "updated") {
              await tx.connectorStagedRecord.update({ where: { id: k!.id }, data: { payload: it.data, payloadHash: it.hash, version: k!.version + 1, lastRunId: runId } })
              known.set(it.externalId, { ...k!, payloadHash: it.hash, version: k!.version + 1 })
            }
          }
          cursor = p.cursor
          if (!p.hasMore) break
        }
        if (cursor !== null) wm[r.key] = cursor
      }
      const after = serializeWatermark(wm)
      await tx.connectorSyncRun.create({ data: { id: runId, companyId: ctx.companyId, settingId: s.id, connectorKey: key, mode: "SIMULATION", status: "SUCCEEDED", triggeredById: ctx.userId, startedAt, finishedAt: clock(), watermarkBefore: s.watermark, watermarkAfter: after, ...counts } })
      await tx.connectorSetting.update({ where: { id: s.id }, data: { watermark: after } })
      await audit(tx, ctx, s.id, `Connecteur ${def.label} : synchronisation simulée (${counts.received} reçus, ${counts.created} nouveaux, ${counts.updated} modifiés, ${counts.unchanged} inchangés)`)
      return { runId, watermark: after, ...counts }
    }, { timeout: 30_000 })
    return { ok: true, value }
  } catch (e) {
    if (e instanceof ConnectorFailure) return { ok: false, error: e.userMessage }
    const code: SyncErrorCode = toErrorCode(e)
    // Journal de l'échec, à part (la transaction de synchronisation est annulée) : code stable seulement.
    try {
      const s = await db.connectorSetting.findFirst({ where: { companyId: ctx.companyId, connectorKey: key }, select: { id: true, watermark: true } })
      if (s) await db.connectorSyncRun.create({ data: { id: runId, companyId: ctx.companyId, settingId: s.id, connectorKey: key, mode: "SIMULATION", status: "FAILED", triggeredById: ctx.userId, startedAt, finishedAt: clock(), watermarkBefore: s.watermark, watermarkAfter: s.watermark, errorCode: code } })
    } catch (logError) {
      console.error("[connecteurs] journal d'échec non écrit", { connectorKey: key, name: logError instanceof Error ? logError.name : typeof logError })
    }
    if (code === "INTERNAL_ERROR") console.error("[connecteurs] synchronisation en échec", { connectorKey: key, name: e instanceof Error ? e.name : typeof e })
    return { ok: false, error: SYNC_ERROR_LABEL[code] }
  }
}
