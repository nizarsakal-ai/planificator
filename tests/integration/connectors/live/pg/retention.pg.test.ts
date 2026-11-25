/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8D : rétention RGPD (zone de transit 365 jours, secrets terminés 90 jours) sur une base
 * PostgreSQL JETABLE migrée. Les âges sont posés en base avec l'horloge du serveur (la base revérifie elle-même l'âge).
 * Exécution : TEST_PG_ADMIN_URL=… sh tests/billing/pg/with-disposable-db.sh ret npm run test:connector-retention:pg
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { loadKeyring } from "@/lib/integration/secrets/keyring"
import { assignCredentialsRef, storeCredential } from "@/lib/integration/persistence/secret-provider.service"
import { destroyExpiredCredentials, eraseStagedRecord, purgeExpiredStagedRecords } from "@/lib/integration/connectors/live/retention.service"
import { GET as cron } from "@/app/api/cron/connector-retention/route"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const keyring = loadKeyring({ INTEGRATION_KEK_ACTIVE_ID: "k1", INTEGRATION_KEK_K1: randomBytes(32).toString("base64") })
const D = { keyring, environment: "test" as const }
const C = { companyId: "retA", connectionId: "retConn" }
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }
const staged = (id: string, company: string, ageDays: number) =>
  db.$executeRawUnsafe(`INSERT INTO connector_staged_records(id,"companyId","connectorKey",resource,"externalId","payloadHash",payload,"firstRunId","lastRunId","createdAt","updatedAt") VALUES ('${id}','${company}','shopify','customers','${id}','${"a".repeat(64)}','{}','r','r',now() - interval '${ageDays} days',(now() AT TIME ZONE 'UTC') - interval '${ageDays} days')`)
/** Version de secret créée par le vrai coffre, puis menée à un état final daté dans le passé (horloge du serveur). */
async function version(final: "REVOKED" | "RETIRED" | "FAILED" | "ACTIVE", endedDaysAgo: number): Promise<string> {
  const v = await storeCredential(db, { ...C, secretKind: "API_KEY", plaintext: `secret-${final}-${endedDaysAgo}-${Math.random()}`, actorId: "uRet" }, D)
  const ago = (d: number) => `(now() AT TIME ZONE 'UTC') - interval '${d} days'`
  if (final === "FAILED") { await db.$executeRawUnsafe(`UPDATE integration_credential_versions SET status='FAILED', "failedAt"=${ago(endedDaysAgo)} WHERE id='${v.versionId}'`); return v.versionId }
  await db.$executeRawUnsafe(`UPDATE integration_credential_versions SET status='ACTIVE', "activatedAt"=${ago(endedDaysAgo + 10)} WHERE id='${v.versionId}'`)
  if (final === "RETIRED") await db.$executeRawUnsafe(`UPDATE integration_credential_versions SET status='RETIRED', "retiredAt"=${ago(endedDaysAgo)} WHERE id='${v.versionId}'`)
  if (final === "REVOKED") await db.$executeRawUnsafe(`UPDATE integration_credential_versions SET status='REVOKED', "revokedAt"=${ago(endedDaysAgo)}, "revokedReason"='TEST' WHERE id='${v.versionId}'`)
  return v.versionId
}

before(async () => {
  for (const [id, slug, n] of [["retA", "ret-a", 1], ["retB", "ret-b", 2]] as const) {
    await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('${id}','Société ${id}','${slug}','4445556660001${n}','1 rue',now())`)
    await db.$executeRawUnsafe(`INSERT INTO connector_settings(id,"companyId","connectorKey",mode,"changedById","changedAt") VALUES ('set${id}','${id}','shopify','SIMULATION','uRet',now())`)
  }
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('uRet','ret@x.test','x',now()),('uRetB','retb@x.test','x',now())`)
  await db.$executeRawUnsafe(`INSERT INTO integration_connections(id,"companyId","connectorType","displayName",status,"secretBackend",config,"updatedAt") VALUES ('retConn','retA','shopify','Boutique','ACTIVE','PLATFORM_ENCRYPTED','{}',now())`)
  await assignCredentialsRef(db, C)
})
after(async () => { await db.$disconnect() })

describe("zone de transit : 365 jours", () => {
  it("purge : les éléments de plus de 365 jours sont supprimés, les plus récents gardés, toutes sociétés", async () => {
    await staged("old-a", "retA", 400); await staged("old-b", "retB", 366); await staged("young-a", "retA", 300)
    assert.equal(await purgeExpiredStagedRecords(db), 2)
    assert.deepEqual((await db.connectorStagedRecord.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((r) => r.id), ["young-a"])
  })
  it("la base refuse toute autre suppression : sans annonce, ou trop récent même annoncé ; TRUNCATE toujours interdit", async () => {
    assert.match(await sqlError(`DELETE FROM connector_staged_records WHERE id='young-a'`), /staged record cannot be deleted/)
    assert.match(await sqlError(`BEGIN; SELECT set_config('planificator.retention_purge','on',true); DELETE FROM connector_staged_records WHERE id='young-a'; COMMIT;`), /staged record cannot be deleted|cannot insert multiple commands/)
    const young = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('planificator.retention_purge', 'on', true)`
      try { await tx.$executeRaw`DELETE FROM connector_staged_records WHERE id = 'young-a'`; return "NO_ERROR" } catch (e) { return String((e as Error).message) }
    }).catch((e: Error) => e.message)
    assert.match(young, /staged record cannot be deleted/, "âge revérifié par la base")
    assert.match(await sqlError(`TRUNCATE connector_staged_records`), /immutable|cannot/i)
    assert.equal(await db.connectorStagedRecord.count(), 1)
  })
  it("effacement ciblé : l'élément de la société de session seulement, journalisé ; une autre société ne peut rien effacer", async () => {
    await staged("young-b", "retB", 10)
    assert.equal(await eraseStagedRecord(db, { companyId: "retB", userId: "uRetB" }, "young-a"), false, "élément d'une autre société")
    assert.equal(await eraseStagedRecord(db, { companyId: "retA", userId: "uRet" }, "young-a"), true)
    assert.deepEqual((await db.connectorStagedRecord.findMany({ select: { id: true } })).map((r) => r.id), ["young-b"])
    const log = await db.historyLog.findFirstOrThrow({ where: { entityType: "ConnectorStagedRecord", entityId: "young-a" } })
    assert.equal(log.actorId, "uRet")
    assert.match(await sqlError(`DELETE FROM connector_staged_records WHERE id='young-b'`), /staged record cannot be deleted/, "l'autorisation ne dépasse pas la transaction")
  })
})

describe("coffre : destruction 90 jours après la fin de vie", () => {
  it("REVOKED, RETIRED, FAILED de plus de 90 jours ⇒ DESTROYED, matériel à zéro, indice effacé, audit ; récents et ACTIVE intacts", async () => {
    const due = [await version("REVOKED", 100), await version("RETIRED", 95), await version("FAILED", 120)]
    const keep = [await version("REVOKED", 30), await version("FAILED", 89)]
    assert.equal(await destroyExpiredCredentials(db, "test"), 3)
    for (const id of due) {
      const v = await db.integrationCredentialVersion.findUniqueOrThrow({ where: { id } })
      assert.equal(v.status, "DESTROYED")
      assert.ok(v.destroyedAt)
      assert.equal(v.keyId, "destroyed")
      assert.equal(v.hint, null)
      assert.ok(Buffer.from(v.wrappedDek).equals(Buffer.alloc(32)) && Buffer.from(v.ciphertext).equals(Buffer.alloc(1)))
    }
    for (const id of keep) assert.notEqual((await db.integrationCredentialVersion.findUniqueOrThrow({ where: { id } })).status, "DESTROYED")
    assert.equal(await db.integrationSecretAuditLog.count({ where: { action: "CREDENTIAL_DESTROYED", reasonCode: "RETENTION_EXPIRED" } }), 3)
    assert.equal(await destroyExpiredCredentials(db, "test"), 0, "idempotent")
  })
  it("la base refuse : destruction avant 90 jours, matériel non nul, toute modification après destruction, suppression", async () => {
    const young = await version("REVOKED", 30)
    const z = (n: number) => `'\\x${"00".repeat(n)}'::bytea`
    const destroySql = (id: string, wrapped = z(32)) => `UPDATE integration_credential_versions SET status='DESTROYED', "destroyedAt"=now(), "keyId"='destroyed', hint=NULL, "wrappedDek"=${wrapped}, "dekNonce"=${z(12)}, "dekTag"=${z(16)}, nonce=${z(12)}, tag=${z(16)}, ciphertext=${z(1)} WHERE id='${id}'`
    assert.match(await sqlError(destroySql(young)), /only 90 days after it ended/)
    const old = await version("REVOKED", 200)
    assert.match(await sqlError(destroySql(old, `'\\x${"11".repeat(32)}'::bytea`)), /values_check/, "matériel non nul refusé")
    assert.equal(await sqlError(destroySql(old)), "NO_ERROR")
    assert.match(await sqlError(`UPDATE integration_credential_versions SET "revokedReason"='AUTRE' WHERE id='${old}'`), /destroyed credential version is final/)
    assert.match(await sqlError(`DELETE FROM integration_credential_versions WHERE id='${old}'`), /cannot be deleted/)
    const active = await version("ACTIVE", 300)
    assert.match(await sqlError(destroySql(active)), /only 90 days after it ended/, "une version ACTIVE ne se détruit pas")
  })
})

describe("tâche planifiée", () => {
  it("refuse sans jeton ; avec CRON_SECRET, renvoie les seuls compteurs", async () => {
    process.env.CRON_SECRET = "cron-test-" + "x".repeat(16)
    const denied = await cron(new Request("https://planificator.test/api/cron/connector-retention"))
    assert.ok(denied.status === 401 || denied.status === 403)
    const logged: unknown[][] = []
    const original = console.info
    console.info = (...args: unknown[]) => { logged.push(args) }
    let ok: Response
    try {
      ok = await cron(new Request("https://planificator.test/api/cron/connector-retention", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }), undefined, { db })
    } finally {
      console.info = original
    }
    assert.equal(ok.status, 200)
    const body = await ok.json()
    assert.deepEqual(Object.keys(body).sort(), ["credentialsDestroyed", "stagedPurged"])
    // Journal de preuve d'exécution : une ligne, les mêmes compteurs, rien d'autre.
    assert.deepEqual(logged, [["[connecteurs][retention] terminé", body]])
  })
})
