/**
 * LOT-2B — PostgreSQL : Bindings, invariant IDENTITÉ porté par la base, bornes en base, façade d'administration
 * (AuthZ, société de session, audit sans valeur brute). Base jetable migrée.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { PipelineBindingRepository } from "@/lib/integration/persistence/pipeline-binding.repository"
import { RoutingConfigAuditRepository } from "@/lib/integration/persistence/routing-config-audit.repository"
import { RoutingConfigAdminService, RoutingConfigForbiddenError } from "@/lib/integration/sources/routing-config-admin.service"
import { InboundSourceConflictError, InboundSourceValidationError } from "@/lib/integration/persistence/inbound-source.errors"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) { console.error("Tests PG LOT-2B : fournir TEST_INTEGRATION_DATABASE_URL."); process.exit(1) }
assertSafeDisposableTestDatabaseUrl(resolved.url)
const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
const run = Math.random().toString(36).slice(2, 8)
const A = `rcA${run}`, B = `rcB${run}`, U = `rcU${run}`
const admin = { companyId: A, userId: U, role: "ADMIN" }
const svc = () => new RoutingConfigAdminService(
  new InboundSourceWriteService(new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db)),
  new PipelineBindingRepository(db), new RoutingConfigAuditRepository(db),
)
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

before(async () => {
  for (const [id, n] of [[A, 1], [B, 2]] as const) await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('${id}','Société ${id}','${id.toLowerCase()}','7778889990001${n}','1 rue',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('${U}','${U}@x.test','x',now())`)
  for (const [id, co] of [[`cnA${run}`, A], [`cnB${run}`, B]]) await db.$executeRawUnsafe(`INSERT INTO integration_connections(id,"companyId","connectorType","displayName",status,"secretBackend",config,"updatedAt") VALUES ('${id}','${co}','platform.mail.legacy','Boîte','ACTIVE','LEGACY_GMAIL','{}',now())`)
})
after(async () => { await db.$disconnect() })

describe("façade d'administration : AuthZ, société de session, audit", () => {
  it("refuse tout rôle non administrateur et toute identité incomplète", async () => {
    for (const actor of [{ ...admin, role: "EMPLOYEE" }, { ...admin, role: "" }, { ...admin, userId: "" }, { ...admin, companyId: "" }])
      await assert.rejects(svc().createSource(actor, "Maison Martin"), RoutingConfigForbiddenError)
    assert.equal(await db.inboundSource.count({ where: { companyId: A } }), 0)
  })
  it("configuration complète : Source, règles, Binding, activation ; audit sans aucune valeur", async () => {
    const s = svc()
    const src = await s.createSource(admin, "Maison Martin")
    await s.createRule(admin, { sourceId: src.id, type: "SENDER_DOMAIN", value: "  Maison-Martin.FR " })
    const kw = await s.createRule(admin, { sourceId: src.id, type: "SUBJECT_KEYWORD", value: "Demande de DEVIS" })
    assert.equal(kw.normalizedValue, "demande de devis")
    const bind = await s.createBinding(admin, { sourceId: src.id })
    await s.setSourceEnabled(admin, src.id, true)
    await s.setBindingEnabled(admin, bind.id, true)
    const logs = await db.historyLog.findMany({ where: { companyId: A, entityType: { in: ["InboundSource", "InboundSourceRule", "PipelineBinding"] } } })
    assert.equal(logs.length, 6)
    assert.ok(logs.every((l) => l.actorId === U))
    assert.doesNotMatch(JSON.stringify(logs), /maison-martin|devis/i, "aucune valeur de règle dans l'audit")
  })
})

describe("Bindings", () => {
  it("au plus un Binding actif par Source (index unique partiel) ; inactifs multiples permis", async () => {
    const s = svc()
    const src = await s.createSource(admin, "Source deux")
    const b1 = await s.createBinding(admin, { sourceId: src.id })
    const b2 = await s.createBinding(admin, { sourceId: src.id })
    await s.setBindingEnabled(admin, b1.id, true)
    await assert.rejects(s.setBindingEnabled(admin, b2.id, true), InboundSourceConflictError)
    await s.setBindingEnabled(admin, b1.id, false)
    assert.equal((await s.setBindingEnabled(admin, b2.id, true)).enabled, true)
  })
  it("scope Connection : seulement une Connection de la même société ; pipeline figé à consultations", async () => {
    const s = svc()
    const src = await s.createSource(admin, "Source trois")
    assert.equal((await s.createBinding(admin, { sourceId: src.id, connectionId: `cnA${run}` })).connectionId, `cnA${run}`)
    await assert.rejects(s.createBinding(admin, { sourceId: src.id, connectionId: `cnB${run}` }), InboundSourceValidationError, "Connection d'une autre société")
    assert.match(await sqlError(`INSERT INTO integration_pipeline_bindings(id,"companyId","sourceId","pipelineId","updatedAt") VALUES ('pb${run}','${A}','${src.id}','autre',now())`), /values_check/)
  })
  it("une Source d'une autre société est refusée", async () => {
    const other = await new InboundSourceRepository(db).create({ companyId: B, displayName: "Chez B", enabled: false })
    await assert.rejects(svc().createBinding(admin, { sourceId: other.id }), InboundSourceValidationError)
  })
})

describe("garde-fous en base", () => {
  it("Source active sans règle d'identité active : refusée au COMMIT, même en SQL direct", async () => {
    const src = await svc().createSource(admin, "Sans identité")
    assert.match(await sqlError(`UPDATE integration_inbound_sources SET enabled = true WHERE id = '${src.id}'`), /enabled inbound source requires an enabled identity rule/)
    const ok = await svc().createSource(admin, "Avec identité")
    await svc().createRule(admin, { sourceId: ok.id, type: "SENDER_EMAIL", value: "contact@exemple.invalid" })
    await svc().setSourceEnabled(admin, ok.id, true)
    assert.match(await sqlError(`DELETE FROM integration_inbound_source_rules WHERE "sourceId" = '${ok.id}'`), /enabled inbound source requires an enabled identity rule/, "dernière identité supprimée")
    assert.match(await sqlError(`UPDATE integration_inbound_source_rules SET enabled = false WHERE "sourceId" = '${ok.id}'`), /enabled inbound source requires an enabled identity rule/, "dernière identité désactivée")
  })
  it("bornes : mot-clé de plus de 128 caractères, valeur vide, nom vide refusés par la base", async () => {
    const src = await svc().createSource(admin, "Bornes")
    assert.match(await sqlError(`INSERT INTO integration_inbound_source_rules(id,"companyId","sourceId",type,value,"normalizedValue","updatedAt") VALUES ('r1${run}','${A}','${src.id}','SUBJECT_KEYWORD','x','${"k".repeat(129)}',now())`), /values_check/)
    assert.match(await sqlError(`INSERT INTO integration_inbound_source_rules(id,"companyId","sourceId",type,value,"normalizedValue","updatedAt") VALUES ('r2${run}','${A}','${src.id}','SENDER_EMAIL','','a@b.fr',now())`), /values_check/)
    assert.match(await sqlError(`UPDATE integration_inbound_sources SET "displayName" = '   ' WHERE id = '${src.id}'`), /values_check/)
  })
})

describe("audit atomique (revue du 24/11, point 5)", () => {
  it("audit impossible (acteur inconnu) : la mutation est annulée, aucune Source orpheline", async () => {
    const svcTx = RoutingConfigAdminService.transactional(db)
    const before = await db.inboundSource.count({ where: { companyId: A } })
    await assert.rejects(svcTx.createSource({ companyId: A, userId: `inconnu${run}`, role: "ADMIN" }, "Sans trace"))
    assert.equal(await db.inboundSource.count({ where: { companyId: A } }), before)
  })
  it("chemin transactionnel complet : Source, règle, Binding, activation, chacun avec son audit", async () => {
    const svcTx = RoutingConfigAdminService.transactional(db)
    const src = await svcTx.createSource(admin, "Transactionnelle")
    await svcTx.createRule(admin, { sourceId: src.id, type: "SENDER_DOMAIN", value: "transaction.fr" })
    const b = await svcTx.createBinding(admin, { sourceId: src.id })
    await svcTx.setBindingEnabled(admin, b.id, true)
    const on = await svcTx.setSourceEnabled(admin, src.id, true)
    assert.equal(on.enabled, true)
    assert.equal(await db.historyLog.count({ where: { companyId: A, entityId: { in: [src.id, b.id] } } }), 4)
  })
})
