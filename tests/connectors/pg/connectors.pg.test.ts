/**
 * Lot F Planificator V2 : centre de connecteurs sur une base PostgreSQL JETABLE. Désactivé par défaut, simulation
 * explicite, synchronisation idempotente (curseur, réinitialisation, nouvelle version), échec tout-ou-rien journalisé
 * par code, synchronisations concurrentes sérialisées, isolation entre entreprises, garanties de la base, et AUCUN
 * appel réseau (fetch remplacé par un compteur pendant tout le fichier).
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh connectors npm run test:connectors:pg
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as svc from "@/lib/connectors/connectors.service"
import { listStagedRecords, loadConnectorCenter } from "@/lib/connectors/queries"
import { CONNECTOR_ERRORS, ConnectorSourceError, SYNC_ERROR_LABEL, type SourceItem } from "@/lib/connectors/connectors.core"
import { SIMULATED_COUNT, simulationTransport, type ConnectorTransport } from "@/lib/connectors/transport"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const originalFetch = globalThis.fetch
let networkCalls = 0

/** Double fictif modifiable : une source « vivante » pour éprouver nouvelles versions et pannes. */
function mutableSource(items: SourceItem[], opts: { failAfter?: number } = {}): ConnectorTransport {
  let served = 0
  return {
    kind: "SIMULATION",
    async fetchPage(req) {
      const from = req.cursor ? Number(req.cursor.slice(4)) : 0
      if (opts.failAfter !== undefined && served >= opts.failAfter) throw new ConnectorSourceError("SOURCE_UNAVAILABLE")
      const list = req.resource === "orders" ? items : []
      const page = list.slice(from, from + 2)
      served += page.length
      return { items: page, cursor: `seq:${from + page.length}`, hasMore: from + page.length < list.length }
    },
  }
}

before(async () => {
  globalThis.fetch = (async () => { networkCalls++; throw new Error("réseau interdit en test") }) as typeof fetch
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`)
  // Acteurs du journal (history_logs.actorId → users.id) : la clé étrangère et l'historique sont conservés tels quels.
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uB','b@x.test','x',now())`)
})
after(async () => {
  globalThis.fetch = originalFetch
  await db.$disconnect()
})

describe("modes", () => {
  it("désactivé par défaut : synchronisation refusée, rien écrit ; mode inconnu ou « réel » refusé", async () => {
    assert.deepEqual(await svc.runConnectorSync(db, A, "shopify"), { ok: false, error: CONNECTOR_ERRORS.notSimulation })
    assert.deepEqual(await svc.setConnectorMode(db, A, "shopify", "LIVE"), { ok: false, error: CONNECTOR_ERRORS.liveUnavailable }, "LOT-8B : LIVE sans drapeau ni identifiants vérifiés")
    assert.deepEqual(await svc.setConnectorMode(db, A, "shopify", "REAL"), { ok: false, error: CONNECTOR_ERRORS.mode })
    assert.deepEqual(await svc.setConnectorMode(db, A, "shopify", "DISABLED"), { ok: false, error: CONNECTOR_ERRORS.sameMode })
    assert.deepEqual(await svc.setConnectorMode(db, A, "hubspot", "SIMULATION"), { ok: false, error: CONNECTOR_ERRORS.notFound })
    assert.equal(await db.connectorSyncRun.count(), 0)
    assert.equal(await db.connectorStagedRecord.count(), 0)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_settings(id,"companyId","connectorKey",mode,"changedById","changedAt") VALUES ('x','coA','hubspot','SIMULATION','uA',now())`), /connector_settings_values_check/)
  })
  it("simulation activée et auditée", async () => {
    ok(await svc.setConnectorMode(db, A, "shopify", "SIMULATION"))
    assert.deepEqual(await svc.setConnectorMode(db, A, "shopify", "SIMULATION"), { ok: false, error: CONNECTOR_ERRORS.sameMode })
    assert.equal(await db.historyLog.count({ where: { companyId: "coA", entityType: "ConnectorSetting" } }), 1)
  })
})

describe("synchronisation simulée", () => {
  it("première passe : tout reçu une fois ; seconde : rien de nouveau (curseur) ; isolation de l'autre entreprise", async () => {
    const s1 = ok(await svc.runConnectorSync(db, A, "shopify"))
    assert.deepEqual([s1.received, s1.created, s1.updated, s1.unchanged], [2 * SIMULATED_COUNT, 2 * SIMULATED_COUNT, 0, 0])
    assert.equal(s1.watermark, `{"customers":"seq:${SIMULATED_COUNT}","orders":"seq:${SIMULATED_COUNT}"}`)
    const s2 = ok(await svc.runConnectorSync(db, A, "shopify"))
    assert.deepEqual([s2.received, s2.created], [0, 0])
    assert.equal(await db.connectorStagedRecord.count({ where: { companyId: "coA" } }), 2 * SIMULATED_COUNT)
    assert.deepEqual(await svc.runConnectorSync(db, B, "shopify"), { ok: false, error: CONNECTOR_ERRORS.notSimulation }, "réglage propre à chaque entreprise")
    assert.equal(await db.connectorStagedRecord.count({ where: { companyId: "coB" } }), 0)
  })
  it("curseur réinitialisé : tout relu, rien dupliqué (inchangé) ; journal des exécutions", async () => {
    ok(await svc.resetConnectorWatermark(db, A, "shopify"))
    const s = ok(await svc.runConnectorSync(db, A, "shopify"))
    assert.deepEqual([s.received, s.created, s.updated, s.unchanged], [2 * SIMULATED_COUNT, 0, 0, 2 * SIMULATED_COUNT])
    assert.equal(await db.connectorStagedRecord.count({ where: { companyId: "coA" } }), 2 * SIMULATED_COUNT)
    assert.ok((await db.connectorStagedRecord.findMany({ where: { companyId: "coA" }, select: { version: true } })).every((r) => r.version === 1))
    assert.equal(await db.connectorSyncRun.count({ where: { companyId: "coA", status: "SUCCEEDED" } }), 3)
  })
  it("contenu modifié à la source ⇒ nouvelle version, une seule fois", async () => {
    ok(await svc.setConnectorMode(db, A, "stripe", "SIMULATION"))
    ok(await svc.setConnectorMode(db, B, "shopify", "SIMULATION"))
    const items: SourceItem[] = [{ externalId: "o-1", data: { totalCents: 100 } }, { externalId: "o-2", data: { totalCents: 200 } }, { externalId: "o-3", data: { totalCents: 300 } }]
    assert.deepEqual((({ received, created }) => [received, created])(ok(await svc.runConnectorSync(db, B, "shopify", { transport: mutableSource(items) }))), [3, 3])
    ok(await svc.resetConnectorWatermark(db, B, "shopify"))
    items[1] = { externalId: "o-2", data: { totalCents: 250 } }
    const s = ok(await svc.runConnectorSync(db, B, "shopify", { transport: mutableSource(items) }))
    assert.deepEqual([s.received, s.created, s.updated, s.unchanged], [3, 0, 1, 2])
    const r = await db.connectorStagedRecord.findFirstOrThrow({ where: { companyId: "coB", externalId: "o-2" }, select: { version: true, payload: true, firstRunId: true, lastRunId: true } })
    assert.deepEqual([r.version, r.payload], [2, { totalCents: 250 }])
    assert.notEqual(r.firstRunId, r.lastRunId)
  })
  it("panne de la source en cours de route : tout annulé (éléments et curseur), échec journalisé avec un code seulement", async () => {
    ok(await svc.resetConnectorWatermark(db, B, "shopify"))
    const before = await db.connectorSetting.findFirstOrThrow({ where: { companyId: "coB", connectorKey: "shopify" }, select: { watermark: true } })
    const items: SourceItem[] = Array.from({ length: 6 }, (_, i) => ({ externalId: `n-${i}`, data: { v: i } }))
    const r = await svc.runConnectorSync(db, B, "shopify", { transport: mutableSource(items, { failAfter: 2 }) })
    assert.deepEqual(r, { ok: false, error: SYNC_ERROR_LABEL.SOURCE_UNAVAILABLE })
    assert.equal(await db.connectorStagedRecord.count({ where: { companyId: "coB", externalId: { startsWith: "n-" } } }), 0, "rien de la page reçue avant la panne")
    const afterFail = await db.connectorSetting.findFirstOrThrow({ where: { companyId: "coB", connectorKey: "shopify" }, select: { watermark: true } })
    assert.equal(afterFail.watermark, before.watermark)
    const failed = await db.connectorSyncRun.findFirstOrThrow({ where: { companyId: "coB", status: "FAILED" }, select: { errorCode: true, received: true } })
    assert.deepEqual(failed, { errorCode: "SOURCE_UNAVAILABLE", received: 0 })
    const bad = await svc.runConnectorSync(db, B, "shopify", { transport: { kind: "SIMULATION", fetchPage: async () => { throw new Error("Bearer sk_live_SECRET refusé") } } })
    assert.deepEqual(bad, { ok: false, error: SYNC_ERROR_LABEL.INTERNAL_ERROR })
    const runs = await db.connectorSyncRun.findMany({ where: { companyId: "coB" }, select: { errorCode: true, watermarkBefore: true, watermarkAfter: true } })
    assert.ok(!JSON.stringify(runs).includes("sk_live"), "aucun message d'origine conservé")
  })
  it("isolation des lectures d'écran : chaque entreprise ne voit que ses réglages, exécutions et données reçues", async () => {
    const a = await loadConnectorCenter(db, "coA"), b = await loadConnectorCenter(db, "coB")
    const shopA = a.connectors.find((c) => c.def.key === "shopify")!, shopB = b.connectors.find((c) => c.def.key === "shopify")!
    assert.equal(shopA.staged.orders + shopA.staged.customers, 2 * SIMULATED_COUNT)
    assert.ok(shopB.staged.orders <= 3 && shopB.staged.customers === 0, "données de B seulement (source fictive modifiable)")
    assert.ok((await listStagedRecords(db, "coB", "shopify", 200)).every((r) => !r.externalId.startsWith("fictif-")), "aucune donnée de A chez B")
    assert.ok((await listStagedRecords(db, "coA", "shopify", 200)).every((r) => r.externalId.startsWith("fictif-")), "aucune donnée de B chez A")
    assert.equal(a.connectors.find((c) => c.def.key === "stripe")!.mode, "SIMULATION")
    assert.equal(b.connectors.find((c) => c.def.key === "stripe")!.mode, "DISABLED", "réglage propre à chaque entreprise")
  })
  it("v4 ChatGPT : désactivé au départ, 12 métadonnées fictives au premier passage, 0 au second, invisible pour l'autre société, mode réel indisponible", async () => {
    // État initial : désactivé, rien en transit, synchronisation refusée.
    assert.equal((await loadConnectorCenter(db, "coA")).connectors.find((c) => c.def.key === "chatgpt")!.mode, "DISABLED")
    assert.deepEqual(await svc.runConnectorSync(db, A, "chatgpt"), { ok: false, error: CONNECTOR_ERRORS.notSimulation })
    assert.equal(await db.connectorStagedRecord.count({ where: { connectorKey: "chatgpt" } }), 0)
    // Mode réel : n'existe ni en code ni en base ; un transport non simulé est refusé avant toute écriture.
    assert.deepEqual(await svc.setConnectorMode(db, A, "chatgpt", "LIVE", undefined, { liveAllowed: true }), { ok: false, error: CONNECTOR_ERRORS.liveUnavailable }, "aucun adaptateur réel pour ChatGPT")
    ok(await svc.setConnectorMode(db, A, "chatgpt", "SIMULATION"))
    const real = { kind: "REAL", fetchPage: async () => { throw new Error("jamais appelé") } } as unknown as ConnectorTransport
    assert.deepEqual(await svc.runConnectorSync(db, A, "chatgpt", { transport: real }), { ok: false, error: SYNC_ERROR_LABEL.REAL_CONNECTION_DISABLED })
    await assert.rejects(db.$executeRawUnsafe(`UPDATE connector_settings SET mode = 'LIVE' WHERE "companyId" = 'coA' AND "connectorKey" = 'chatgpt'`), /connector_settings_live_check|live mode requires/)
    // Premier passage : 12 conversations fictives (métadonnées seulement) ; second : rien de nouveau.
    const s1 = ok(await svc.runConnectorSync(db, A, "chatgpt"))
    assert.deepEqual([s1.received, s1.created, s1.updated, s1.unchanged], [SIMULATED_COUNT, SIMULATED_COUNT, 0, 0])
    assert.equal(SIMULATED_COUNT, 12)
    const s2 = ok(await svc.runConnectorSync(db, A, "chatgpt"))
    assert.deepEqual([s2.received, s2.created], [0, 0])
    const recs = await listStagedRecords(db, "coA", "chatgpt", 50)
    assert.equal(recs.length, 12)
    assert.ok(recs.every((r) => r.resource === "conversations" && (r.payload as Record<string, unknown>).fictitious === true))
    assert.ok(recs.every((r) => Object.keys(r.payload as object).sort().join(",") === "createdOn,fictitious,title"), "titre et date seulement")
    // Autre société : aucun accès, réglage propre.
    assert.equal((await loadConnectorCenter(db, "coB")).connectors.find((c) => c.def.key === "chatgpt")!.mode, "DISABLED")
    assert.deepEqual(await listStagedRecords(db, "coB", "chatgpt", 50), [])
    assert.deepEqual(await svc.runConnectorSync(db, B, "chatgpt"), { ok: false, error: CONNECTOR_ERRORS.notSimulation })
    assert.equal(await db.connectorStagedRecord.count({ where: { companyId: "coB", connectorKey: "chatgpt" } }), 0)
  })
  it("synchronisations concurrentes du même connecteur : sérialisées, chaque élément compté une seule fois", async () => {
    ok(await svc.setConnectorMode(db, A, "mailchimp", "SIMULATION"))
    const rs = await Promise.all([1, 2, 3].map(() => svc.runConnectorSync(db, A, "mailchimp")))
    const created = rs.map((r) => ok(r).created)
    assert.equal(created.reduce((a, b) => a + b, 0), SIMULATED_COUNT)
    assert.equal(await db.connectorStagedRecord.count({ where: { companyId: "coA", connectorKey: "mailchimp" } }), SIMULATED_COUNT)
  })
  it("désactivé : plus de synchronisation ; réception en transit refusée par la base hors simulation", async () => {
    ok(await svc.setConnectorMode(db, A, "mailchimp", "DISABLED"))
    assert.deepEqual(await svc.runConnectorSync(db, A, "mailchimp", { transport: simulationTransport }), { ok: false, error: CONNECTOR_ERRORS.notSimulation })
    assert.deepEqual(await svc.resetConnectorWatermark(db, A, "mailchimp"), { ok: false, error: CONNECTOR_ERRORS.notSimulation })
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_staged_records(id,"companyId","connectorKey",resource,"externalId","payloadHash",payload,"firstRunId","lastRunId","updatedAt") VALUES ('x','coA','mailchimp','contacts','e','${"a".repeat(64)}','{}','r','r',now())`), /connector is not in simulation or live mode/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_staged_records(id,"companyId","connectorKey",resource,"externalId","payloadHash",payload,"firstRunId","lastRunId","updatedAt") VALUES ('x','coA','stripe','payments','e','${"a".repeat(64)}','{}','r','r',now())`).then(() => db.$executeRawUnsafe(`UPDATE connector_staged_records SET payload='{"x":1}' WHERE id='x'`)), /new version of a changed payload/)
  })
})

describe("garanties de la base", () => {
  it("journal des synchronisations immuable ; réglage et zone de transit jamais supprimés ; mode « réel » inexistant", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE connector_sync_runs SET received = 0`), /lot F history immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM connector_sync_runs`), /lot F history immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM connector_settings`), /connector setting cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM connector_staged_records`), /staged record cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE connector_settings SET mode = 'LIVE'`), /connector_settings_live_check|live mode requires/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE connector_settings SET mode = 'REAL'`), /invalid input value for enum/)
    // Revue Codex du 05/11 : un échec journalisé sans code est refusé (IS NOT NULL explicite dans le CHECK).
    const setting = await db.connectorSetting.findFirstOrThrow({ where: { companyId: "coA", connectorKey: "shopify" }, select: { id: true } })
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_sync_runs(id,"companyId","settingId","connectorKey",mode,status,"triggeredById","startedAt","finishedAt","errorCode") VALUES ('rx','coA','${setting.id}','shopify','SIMULATION','FAILED','uA',now(),now(),NULL)`), /connector_sync_runs_values_check/)
    // Portage ab987847 : formulations POSITIVES de la même contrainte v6, puis variantes refusées.
    // Échec avec code de la liste fermée, rien reçu, curseur inchangé : admis.
    await db.$executeRawUnsafe(`INSERT INTO connector_sync_runs(id,"companyId","settingId","connectorKey",mode,status,"triggeredById","startedAt","finishedAt","watermarkBefore","watermarkAfter","errorCode") VALUES ('rok','coA','${setting.id}','shopify','SIMULATION','FAILED','uA',now(),now(),'w','w','SOURCE_UNAVAILABLE')`)
    assert.equal(await db.connectorSyncRun.count({ where: { id: "rok", status: "FAILED", errorCode: "SOURCE_UNAVAILABLE" } }), 1)
    // Échec : code hors liste, éléments reçus, ou curseur modifié : refusés.
    for (const [id, cols, vals] of [
      ["rk1", `"errorCode"`, `'UNKNOWN_CODE'`],
      ["rk2", `"errorCode",received,created`, `'SOURCE_UNAVAILABLE',1,1`],
      ["rk3", `"errorCode","watermarkBefore","watermarkAfter"`, `'SOURCE_UNAVAILABLE','a','b'`],
    ]) await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_sync_runs(id,"companyId","settingId","connectorKey",mode,status,"triggeredById","startedAt","finishedAt",${cols}) VALUES ('${id}','coA','${setting.id}','shopify','SIMULATION','FAILED','uA',now(),now(),${vals})`), /connector_sync_runs_values_check/, id)
    // Réussite avec un code d'erreur : refusée.
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_sync_runs(id,"companyId","settingId","connectorKey",mode,status,"triggeredById","startedAt","finishedAt","errorCode") VALUES ('rk4','coA','${setting.id}','shopify','SIMULATION','SUCCEEDED','uA',now(),now(),'SOURCE_UNAVAILABLE')`), /connector_sync_runs_values_check/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE connector_settings SET "connectorKey" = 'stripe' WHERE "connectorKey" = 'shopify' AND "companyId" = 'coB'`), /identity immutable/)
  })
  it("AUCUN appel réseau pendant tout le fichier", () => {
    assert.equal(networkCalls, 0)
  })
})
