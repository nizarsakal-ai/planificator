/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : connexions réelles en lecture seule sur PostgreSQL (base jetable migrée),
 * vrais services et vrai coffre ; le service distant est un double injecté (AUCUN appel réseau : `fetch` global piégé).
 * Enregistrement vérifié, aucune coupure si la vérification échoue, garde de la base sur LIVE, synchronisation réelle
 * idempotente, panne et limite journalisées par code, révocation, isolation entre sociétés, aucun clair en base.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { CONNECTOR_ERRORS, SYNC_ERROR_LABEL } from "@/lib/connectors/connectors.core"
import * as svc from "@/lib/connectors/connectors.service"
import { LIVE_ERRORS, configureLiveConnector, loadLiveStatus, revokeLiveConnector, type LiveDeps } from "@/lib/integration/connectors/live/live-connection.service"
import type { FetchLike } from "@/lib/integration/connectors/live/live-http"
import { runLiveConnectorSync } from "@/lib/integration/connectors/live/live-sync.service"
import { resolveCredential } from "@/lib/integration/persistence/secret-provider.service"
import { loadKeyring } from "@/lib/integration/secrets/keyring"
import { SecretProviderError } from "@/lib/integration/secrets/secret-errors"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const keyring = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: randomBytes(32).toString("base64") })
const A = { companyId: "lvA", userId: "lvUA" }
const B = { companyId: "lvB", userId: "lvUB" }
const SHOP_TOKEN = "shp" + "at_" + "B".repeat(32)
const SHOP_TOKEN_2 = "shp" + "at_" + "C".repeat(32)
const MC_KEY = "1".repeat(32) + "-us" + "21"
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const originalFetch = globalThis.fetch
let networkCalls = 0

/** Service distant simulé : statut imposé ou réponses par chemin. */
function remote(handler: (u: URL, headers: Record<string, string>) => { status?: number; body: unknown }): FetchLike {
  return async (input, init) => {
    const r = handler(new URL(input), init.headers)
    return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) }
  }
}
const shopOrders = (ids: number[]) => ids.map((id) => ({ id, name: `#${id}`, created_at: "2026-11-03T08:00:00Z", total_price: "99.90", currency: "EUR", financial_status: "paid", customer: { first_name: "Client", last_name: String(id) } }))
/** Boutique : 3 commandes au départ, 1 client ; `since_id` respecté. */
function shop(state: { orders: number[]; status?: number }): FetchLike {
  return remote((u, h) => {
    if (state.status) return { status: state.status, body: {} }
    if (h["X-Shopify-Access-Token"] !== SHOP_TOKEN && h["X-Shopify-Access-Token"] !== SHOP_TOKEN_2) return { status: 401, body: {} }
    if (u.pathname.endsWith("/shop.json")) return { body: { shop: { id: 1 } } }
    const since = Number(u.searchParams.get("since_id") ?? 0)
    if (u.pathname.endsWith("/orders.json")) return { body: { orders: shopOrders(state.orders.filter((i) => i > since)) } }
    if (u.pathname.endsWith("/customers.json")) return { body: { customers: since >= 7 ? [] : [{ id: 7, first_name: "Ana", last_name: "B", email: "ana@exemple.invalid", orders_count: 2 }] } }
    return { status: 404, body: {} }
  })
}
// Horloge de test : chaque jeu de dépendances avance d'une minute et une seconde, pour respecter le délai minimal entre
// deux synchronisations réelles (correctif du 22/11/2026) ; `sameClock` rejoue l'instant courant.
let clock = Date.parse("2026-12-01T10:00:00Z")
const deps = (fetch: FetchLike): LiveDeps => { clock += 61_000; return sameClock(fetch) }
const sameClock = (fetch: FetchLike): LiveDeps => { const at = clock; return { fetch, secrets: { keyring, environment: "test" }, now: () => new Date(at), sleep: async () => undefined } }
const shopForm = (token = SHOP_TOKEN) => ({ shopDomain: "lv-boutique.myshopify.com", accessToken: token })

before(async () => {
  globalThis.fetch = (async () => { networkCalls++; throw new Error("réseau interdit en test") }) as typeof fetch
  for (const [id, slug, n] of [["lvA", "lv-a", 1], ["lvB", "lv-b", 2]] as const) {
    await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('${id}','Société ${id}','${slug}','9876543210001${n}','1 rue',now())`)
  }
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('lvUA','lva@x.test','x',now()),('lvUB','lvb@x.test','x',now())`)
})
after(async () => {
  globalThis.fetch = originalFetch
  assert.equal(networkCalls, 0, "aucun appel réseau réel")
  await db.$disconnect()
})

describe("enregistrement des identifiants", () => {
  it("coffre non configuré sur le serveur ⇒ refus explicite, aucune version créée", async () => {
    const r = await configureLiveConnector(db, A, "shopify", shopForm(), { fetch: shop({ orders: [] }), secrets: { environment: "test", keyring: undefined } })
    assert.deepEqual(r, { ok: false, error: LIVE_ERRORS.vaultUnavailable })
    assert.equal(await db.integrationCredentialVersion.count(), 0)
  })
  it("saisie invalide refusée avant toute écriture dans le coffre", async () => {
    const r = await configureLiveConnector(db, A, "shopify", { shopDomain: "evil.example.com", accessToken: SHOP_TOKEN }, deps(shop({ orders: [] })))
    assert.equal(r.ok, false)
    assert.equal(await db.integrationCredentialVersion.count(), 0)
  })
  it("identifiants refusés par le service ⇒ version FAILED, connecteur toujours inutilisable en réel", async () => {
    const r = await configureLiveConnector(db, A, "shopify", shopForm("shp" + "at_" + "Z".repeat(32)), deps(shop({ orders: [] })))
    assert.deepEqual(r, { ok: false, error: SYNC_ERROR_LABEL.AUTH_FAILED })
    const st = (await loadLiveStatus(db, A.companyId)).shopify
    assert.equal(st.configured, true); assert.equal(st.usable, false); assert.equal(st.credentialStatus, "FAILED")
    assert.deepEqual(await svc.setConnectorMode(db, A, "shopify", "LIVE", undefined, { liveAllowed: true }), { ok: false, error: CONNECTOR_ERRORS.liveUnavailable }, "la base refuse LIVE sans identifiants actifs")
  })
  it("identifiants vérifiés ⇒ ACTIVE, connexion liée une seule fois, indice seul visible, aucun clair en base", async () => {
    const v = ok(await configureLiveConnector(db, A, "shopify", shopForm(), deps(shop({ orders: [] }))))
    assert.equal(v.hint, "BBBB")
    const st = (await loadLiveStatus(db, A.companyId)).shopify
    assert.deepEqual({ usable: st.usable, hint: st.hint, config: st.config }, { usable: true, hint: "BBBB", config: { shopDomain: "lv-boutique.myshopify.com" } })
    assert.equal(await db.integrationConnection.count({ where: { companyId: A.companyId, connectorType: "shopify", status: { not: "ARCHIVED" } } }), 1)
    const s = await svc.readConnectorSetting(db, A, "shopify")
    assert.equal(s?.mode, "DISABLED", "enregistrer ne bascule pas en réel")
    for (const row of await db.integrationCredentialVersion.findMany({ select: { ciphertext: true, hint: true } })) {
      assert.ok(!Buffer.from(row.ciphertext).toString("latin1").includes("BBBBBBBB"), "aucun clair dans le chiffré")
    }
    const audit = JSON.stringify(await db.integrationSecretAuditLog.findMany())
    assert.ok(!audit.includes(SHOP_TOKEN), "aucun secret dans l'audit")
  })
  it("remplacement refusé par le service ⇒ l'ancienne version reste ACTIVE (aucune coupure)", async () => {
    const r = await configureLiveConnector(db, A, "shopify", shopForm(SHOP_TOKEN_2), deps(shop({ orders: [], status: 401 })))
    assert.equal(r.ok, false)
    const st = (await loadLiveStatus(db, A.companyId)).shopify
    assert.equal(st.usable, true); assert.equal(st.hint, "BBBB")
  })
})

describe("synchronisation réelle", () => {
  const state = { orders: [101, 102, 103] as number[], status: undefined as number | undefined }
  it("LIVE autorisé une fois les identifiants vérifiés ; synchronisation réelle tout ou rien, journal en mode LIVE", async () => {
    ok(await svc.setConnectorMode(db, A, "shopify", "LIVE", undefined, { liveAllowed: true }))
    const r = ok(await runLiveConnectorSync(db, A, "shopify", deps(shop(state))))
    assert.deepEqual({ received: r.received, created: r.created, updated: r.updated, unchanged: r.unchanged }, { received: 4, created: 4, updated: 0, unchanged: 0 })
    assert.equal(r.watermark, JSON.stringify({ customers: "sid:7", orders: "sid:103" }))
    const run = await db.connectorSyncRun.findUniqueOrThrow({ where: { id: r.runId } })
    assert.equal(run.mode, "LIVE"); assert.equal(run.status, "SUCCEEDED")
    const staged = await db.connectorStagedRecord.findMany({ where: { companyId: A.companyId, connectorKey: "shopify" }, orderBy: { externalId: "asc" } })
    assert.deepEqual(staged.map((x) => x.externalId), ["101", "102", "103", "7"])
  })
  it("reprise au curseur : seules les nouveautés sont lues, rien n'est compté deux fois", async () => {
    state.orders.push(104)
    const r = ok(await runLiveConnectorSync(db, A, "shopify", deps(shop(state))))
    assert.deepEqual({ received: r.received, created: r.created }, { received: 1, created: 1 })
  })
  it("délai d'une minute entre deux synchronisations réelles : refus sans journal ni lecture du service", async () => {
    const runs = await db.connectorSyncRun.count({ where: { companyId: A.companyId, connectorKey: "shopify" } })
    let calls = 0
    const counting: FetchLike = async (...a) => { calls++; return shop(state)(...a) }
    assert.deepEqual(await runLiveConnectorSync(db, A, "shopify", sameClock(counting)), { ok: false, error: CONNECTOR_ERRORS.liveCooldown })
    clock += 59_000
    assert.deepEqual(await runLiveConnectorSync(db, A, "shopify", sameClock(counting)), { ok: false, error: CONNECTOR_ERRORS.liveCooldown }, "59 s plus tard : toujours refusé")
    assert.equal(calls, 0, "aucune requête vers la boutique")
    assert.equal(await db.connectorSyncRun.count({ where: { companyId: A.companyId, connectorKey: "shopify" } }), runs)
  })
  it("commandes sans donnée personnelle en zone de transit (correctif du 22/11/2026)", async () => {
    const rec = await db.connectorStagedRecord.findFirstOrThrow({ where: { companyId: A.companyId, connectorKey: "shopify", resource: "orders" } })
    assert.deepEqual(Object.keys(rec.payload as object).sort(), ["currency", "number", "orderedOn", "status", "totalCents"])
  })
  it("limite et refus du service : échec journalisé par code, curseur et données inchangés", async () => {
    const before = await svc.readConnectorSetting(db, A, "shopify")
    const count = await db.connectorStagedRecord.count()
    for (const [status, code] of [[429, "RATE_LIMITED"], [401, "AUTH_FAILED"], [503, "SOURCE_UNAVAILABLE"]] as const) {
      const r = await runLiveConnectorSync(db, A, "shopify", deps(shop({ orders: [105], status })))
      assert.deepEqual(r, { ok: false, error: SYNC_ERROR_LABEL[code] })
      const last = await db.connectorSyncRun.findFirstOrThrow({ where: { companyId: A.companyId, connectorKey: "shopify" }, orderBy: { startedAt: "desc" } })
      assert.equal(last.status, "FAILED"); assert.equal(last.errorCode, code); assert.equal(last.mode, "LIVE")
    }
    assert.equal((await svc.readConnectorSetting(db, A, "shopify"))?.watermark, before?.watermark)
    assert.equal(await db.connectorStagedRecord.count(), count)
  })
  it("la simulation ne s'exécute pas sur un connecteur en connexion réelle (et inversement)", async () => {
    assert.deepEqual(await svc.runConnectorSync(db, A, "shopify"), { ok: false, error: CONNECTOR_ERRORS.notSimulation })
    assert.deepEqual(await runLiveConnectorSync(db, A, "mailchimp", deps(shop(state))), { ok: false, error: CONNECTOR_ERRORS.notLive })
  })
  it("Mailchimp : relecture complète par pages, curseur effacé en fin de lecture ; consentement conservé", async () => {
    const members = Array.from({ length: 3 }, (_, i) => ({ id: `mc${i}`, email_address: `m${i}@exemple.invalid`, status: i === 1 ? "unsubscribed" : "subscribed", timestamp_opt: "2026-02-01T00:00:00Z" }))
    const mc = remote((u) => (u.pathname.endsWith("/members") ? { body: { total_items: 3, members } } : { body: { id: "a1b2c3d4e5" } }))
    ok(await configureLiveConnector(db, A, "mailchimp", { apiKey: MC_KEY, audienceId: "a1b2c3d4e5" }, deps(mc)))
    ok(await svc.setConnectorMode(db, A, "mailchimp", "LIVE", undefined, { liveAllowed: true }))
    const r1 = ok(await runLiveConnectorSync(db, A, "mailchimp", deps(mc)))
    assert.equal(r1.created, 3); assert.equal(r1.watermark, null, "relecture complète la prochaine fois")
    const r2 = ok(await runLiveConnectorSync(db, A, "mailchimp", deps(mc)))
    assert.deepEqual({ received: r2.received, created: r2.created, unchanged: r2.unchanged }, { received: 3, created: 0, unchanged: 3 })
    const rec = await db.connectorStagedRecord.findFirstOrThrow({ where: { companyId: A.companyId, connectorKey: "mailchimp", externalId: "mc1" } })
    assert.equal((rec.payload as Record<string, unknown>).consent, false)
  })
})

describe("garanties de la base", () => {
  it("LIVE refusé hors des trois services, sans connexion, ou vers la connexion d'une autre société", async () => {
    const connA = (await svc.readConnectorSetting(db, A, "shopify"))!.connectionId!
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_settings(id,"companyId","connectorKey",mode,"changedById","changedAt") VALUES ('lvx1','lvB','stripe','LIVE','lvUB',now())`), /connector_settings_live_check|live mode requires/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_settings(id,"companyId","connectorKey",mode,"changedById","changedAt") VALUES ('lvx2','lvB','shopify','LIVE','lvUB',now())`), /connector_settings_live_check|live mode requires/)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_settings(id,"companyId","connectorKey",mode,"connectionId","changedById","changedAt") VALUES ('lvx3','lvB','shopify','DISABLED','${connA}','lvUB',now())`), /foreign key|violates/, "clé composite (id, companyId)")
  })
  it("connexion d'un autre type ou identifiants inactifs ⇒ LIVE refusé ; connexion liée immuable", async () => {
    const connA = (await svc.readConnectorSetting(db, A, "shopify"))!.connectionId!
    await assert.rejects(db.$executeRawUnsafe(`UPDATE connector_settings SET "connectionId" = NULL WHERE "companyId"='lvA' AND "connectorKey"='shopify'`), /immutable|live_check/)
    await db.$executeRawUnsafe(`INSERT INTO integration_connections(id,"companyId","connectorType","displayName",status,"credentialStatus","secretBackend",config,"updatedAt") VALUES ('lvSlackA','lvA','slack','Slack','ACTIVE','ACTIVE','PLATFORM_ENCRYPTED','{}',now())`)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO connector_settings(id,"companyId","connectorKey",mode,"connectionId","changedById","changedAt") VALUES ('lvx4','lvA','slack','LIVE','${connA}','lvUA',now())`), /live mode requires/, "type de connexion ≠ connecteur")
  })
  it("isolation : la société B ne voit ni ne synchronise les connexions de A", async () => {
    assert.deepEqual(await runLiveConnectorSync(db, B, "shopify", deps(shop({ orders: [1] }))), { ok: false, error: CONNECTOR_ERRORS.notLive })
    assert.equal((await loadLiveStatus(db, B.companyId)).shopify.configured, false)
    assert.deepEqual(await revokeLiveConnector(db, B, "shopify", deps(shop({ orders: [] }))), { ok: false, error: LIVE_ERRORS.notConfigured })
  })
})

describe("révocation", () => {
  it("connecteur désactivé, version révoquée, plus aucune résolution ni synchronisation", async () => {
    ok(await revokeLiveConnector(db, A, "shopify", deps(shop({ orders: [] }))))
    const s = (await svc.readConnectorSetting(db, A, "shopify"))!
    assert.equal(s.mode, "DISABLED")
    const st = (await loadLiveStatus(db, A.companyId)).shopify
    assert.equal(st.usable, false); assert.equal(st.credentialStatus, "REVOKED"); assert.equal(st.hint, null)
    await assert.rejects(resolveCredential(db, { companyId: A.companyId, connectionId: s.connectionId!, secretKind: "API_KEY", runtimeCallerId: "connector-runtime", environment: "test" }, { keyring, environment: "test" }), SecretProviderError)
    assert.deepEqual(await runLiveConnectorSync(db, A, "shopify", deps(shop({ orders: [] }))), { ok: false, error: CONNECTOR_ERRORS.notLive })
    assert.deepEqual(await svc.setConnectorMode(db, A, "shopify", "LIVE", undefined, { liveAllowed: true }), { ok: false, error: CONNECTOR_ERRORS.liveUnavailable })
  })
  it("de nouveaux identifiants vérifiés rendent la connexion de nouveau utilisable (même connexion, nouvelle version)", async () => {
    const before = (await svc.readConnectorSetting(db, A, "shopify"))!.connectionId
    ok(await configureLiveConnector(db, A, "shopify", shopForm(SHOP_TOKEN_2), deps(shop({ orders: [] }))))
    assert.equal((await svc.readConnectorSetting(db, A, "shopify"))!.connectionId, before)
    const st = (await loadLiveStatus(db, A.companyId)).shopify
    assert.equal(st.usable, true); assert.equal(st.hint, "CCCC")
  })
})
