import assert from "node:assert/strict"
import { after, before, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"
import { admitConsultation } from "@/lib/acquisition/admission/consultations-admission"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import { AcquisitionScanCursorRepository } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import { TenantRouterService } from "@/lib/integration/router/tenant-router.service"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import { RoutingConfigSnapshotRepository } from "@/lib/integration/persistence/routing-config-snapshot.repository"
import { RoutingDecisionRepository } from "@/lib/integration/persistence/routing-decision.repository"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { PipelineBindingRepository } from "@/lib/integration/persistence/pipeline-binding.repository"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { admitGmailConsultation } from "@/lib/acquisition/admission/gmail-consultations-admission"
import { RoutingShadowService, hashExternalId } from "@/lib/integration/shadow/routing-shadow.service"
import { assertSafeDisposableTestDatabaseUrl } from "./helpers/safe-test-database-url"

const url = process.env.TEST_LOT3_DATABASE_URL
if (!url) throw new Error("TEST_LOT3_DATABASE_URL requis")
assertSafeDisposableTestDatabaseUrl(url)
const target = new URL(url)
assert.equal(target.hostname, "127.0.0.1")
assert.equal(target.pathname, "/pgtest_lot3_local")

const db = new PrismaClient({ datasources: { db: { url } } })
let companyId: string
let partnerId: string
let sourceId: string
let connectionId: string
const envelopes = new InboundEnvelopeRepository(db)
const normalized = new NormalizedInboundRepository(db)
const writerCalls = { legacy: 0, project: 0 }

before(async () => {
  const company = await db.company.create({
    data: { name: "Société fictive LOT-3", slug: "lot3-fictif" },
  })
  companyId = company.id
  const partner = await db.acquisitionPartner.create({
    data: { companyId, name: "Partenaire fictif", code: "fictif" },
  })
  partnerId = partner.id
  await db.acquisitionPartnerDomain.create({
    data: { companyId, partnerId, domainNormalized: "partenaire.example" },
  })
  const connection = await db.integrationConnection.create({
    data: { companyId, connectorType: "platform.mail.legacy", displayName: "Boîte fictive", status: "ACTIVE", secretBackend: "LEGACY_GMAIL", config: {} },
  })
  connectionId = connection.id
  const writes = new InboundSourceWriteService(
    new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db),
  )
  sourceId = (await writes.createSource({ companyId, displayName: "Source fictive" })).id
  await writes.createRule({ companyId, sourceId, type: "SENDER_DOMAIN", value: "partenaire.example" })
  const bindings = new PipelineBindingRepository(db)
  const binding = await bindings.create({ companyId, sourceId, connectionId })
  await bindings.setEnabled(companyId, binding.id, true)
  await writes.setSourceEnabled(companyId, sourceId, true)
})

after(() => db.$disconnect())

function message(externalMessageId: string): RegisterIncomingMessageInput {
  return {
    companyId,
    source: "GMAIL",
    sourceMailboxKey: "boite-fictive",
    externalMessageId,
    senderEmail: "devis@partenaire.example",
    subject: "Consultation fictive",
    receivedAt: new Date("2026-01-01T12:00:00Z"),
    attachments: [],
  }
}

const dependencies = {
  router: {
    route: (input: { companyId: string; normalizedInboundId: string }) => new TenantRouterService({
      normalized, config: new RoutingConfigSnapshotRepository(db), decisions: new RoutingDecisionRepository(db),
      env: {
        INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
        INTEGRATION_ROUTING_ENABLED: "true",
        INTEGRATION_ROUTING_COMPANY_ALLOWLIST: companyId,
      },
      log: () => undefined,
    }).route(input),
  },
  normalized,
  envelopes,
  legacy: (input: RegisterIncomingMessageInput) => {
    writerCalls.legacy++
    return registerIncomingMessage(input, db)
  },
  project: async (input: RegisterIncomingMessageInput, selectedSource: string) => {
    writerCalls.project++
    assert.equal(selectedSource, sourceId)
    const partner = await db.acquisitionPartner.findFirstOrThrow({
      where: { id: partnerId, companyId: input.companyId, active: true, pipeline: "consultations" },
    })
    return registerIncomingMessage(input, db, {
      eligibilityResolver: {
        isDomainEligible: async () => true,
        resolveEligibleSender: async () => ({ partner, matchKind: "DOMAIN" }),
      },
    })
  },
}

async function seedRoute(input: RegisterIncomingMessageInput) {
  const timestamp = "2026-01-01T12:00:00Z"
  const envelope = await envelopes.createIdempotent({
    companyId, connectionId, externalId: input.externalMessageId, idempotencyKey: input.externalMessageId,
    receivedAt: timestamp, payloadRef: "fixture", contentType: "message/rfc822",
  })
  const inbound = await normalized.create({
    companyId, connectionId, envelopeId: envelope.id, family: "MESSAGE",
    occurredAt: timestamp, receivedAt: timestamp, normalizedHash: input.externalMessageId, artifactRefs: [],
    message: { externalMessageId: input.externalMessageId, sender: { email: input.senderEmail }, contentCapabilities: [] },
  })
  return { kind: "router" as const, normalizedInboundId: inbound.id, connectionId, mailboxKey: "boite-fictive" }
}

function admit(input: RegisterIncomingMessageInput, authority: Awaited<ReturnType<typeof seedRoute>>) {
  return admitConsultation(input, authority, dependencies)
}

async function verifySingleDraft(
  input: RegisterIncomingMessageInput,
  results: Awaited<ReturnType<typeof admit>>[],
) {
  const messages = await db.acquisitionMessage.findMany({
    where: { companyId: input.companyId, source: input.source, externalMessageId: input.externalMessageId },
    include: { draft: true },
  })
  assert.equal(messages.length, 1)
  const [saved] = messages
  assert.equal(saved.resolvedPartnerId, partnerId)
  assert.ok(saved.draft)
  assert.equal(results.filter(result => result.outcome === "DRAFT_CREATED" && result.created).length, 1)
  for (const result of results) {
    assert.equal(result.outcome, "DRAFT_CREATED")
    assert.equal(result.messageId, saved.id)
    assert.equal(result.draftId, saved.draft.id)
  }
}

it("rejeu de la décision : même message et même brouillon", async () => {
  const input = message("rejeu")
  const authority = await seedRoute(input)
  const calls = { ...writerCalls }
  const first = await admit(input, authority)
  await verifySingleDraft(input, [first, await admit(input, authority)])
  assert.deepEqual(writerCalls, { legacy: calls.legacy, project: calls.project + 2 })
  assert.equal(await db.routingDecision.count({ where: { normalizedInboundId: authority.normalizedInboundId } }), 1)
})

it("deux admissions simultanées : une seule création", async () => {
  const input = message("concurrence")
  const authority = await seedRoute(input)
  await verifySingleDraft(input, await Promise.all([admit(input, authority), admit(input, authority)]))
})

it("retour au flux historique : réutilise le brouillon créé par le routeur", async () => {
  const input = message("retour-historique")
  const first = await admit(input, await seedRoute(input))
  const calls = { ...writerCalls }
  const legacy = await admitConsultation({ ...input, sourceMailboxKey: "" }, { kind: "legacy" }, dependencies)
  await verifySingleDraft(input, [first, legacy])
  assert.deepEqual(writerCalls, { legacy: calls.legacy + 1, project: calls.project })
})

it("deux versions du flux se chevauchent : un seul brouillon", async () => {
  const input = message("chevauchement")
  const authority = await seedRoute(input)
  await verifySingleDraft(input, await Promise.all([
    admit(input, authority),
    admitConsultation({ ...input, sourceMailboxKey: "" }, { kind: "legacy" }, dependencies),
  ]))
})

it("sans correspondance ou en cas de panne du nouveau flux, aucun repli historique", async () => {
  const input = { ...message("refus"), senderEmail: "contact@autre.example" }
  const authority = await seedRoute(input)
  const calls = { ...writerCalls }
  assert.deepEqual(await admit(input, authority), { outcome: "NOT_ADMITTED" })
  await assert.rejects(admitConsultation(input, authority, {
    ...dependencies, router: { route: async () => { throw new Error("Panne fictive") } },
  }), /Panne fictive/)
  assert.deepEqual(writerCalls, calls)
  assert.equal(await db.acquisitionMessage.count({ where: { companyId, externalMessageId: input.externalMessageId } }), 0)
})

it("Gmail : ancienne projection, admission, rejeu et retour historique", async () => {
  const mailbox = await db.acquisitionGmailConnection.create({
    data: {
      companyId,
      gmailAddress: "boite@partenaire.example",
      accessToken: "fixture",
      refreshToken: "fixture",
      tokenExpiry: new Date("2027-01-01T00:00:00Z"),
      connectedById: "utilisateur-fictif",
    },
  })
  await db.integrationConnection.update({
    where: { id: connectionId },
    data: { config: { gmailMailboxId: mailbox.id, sourcePartners: [{ sourceId, partnerId }] } },
  })
  const env = {
    ...process.env,
    INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
    INTEGRATION_ROUTING_ENABLED: "true",
    INTEGRATION_ROUTING_COMPANY_ALLOWLIST: companyId,
    INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED: "true",
  }
  const externalMessageId = "gmail-admission"
  const timestamp = "2026-01-01T12:00:00Z"
  const oldEnvelope = await envelopes.createIdempotent({
    companyId, connectionId, externalId: externalMessageId, idempotencyKey: externalMessageId,
    receivedAt: timestamp, payloadRef: `mail:${externalMessageId}`, contentType: "message/rfc822",
  })
  const oldProjection = await normalized.create({
    companyId, connectionId, envelopeId: oldEnvelope.id, family: "MESSAGE",
    receivedAt: timestamp, occurredAt: timestamp, normalizedHash: "ancien-hash", artifactRefs: [],
    message: {
      externalMessageId, contentCapabilities: [],
      sender: { email: "Devis <devis@partenaire.example>", domain: "partenaire.example>" },
    },
  })
  await envelopes.transitionLifecycle({
    companyId, envelopeId: oldEnvelope.id, expectedStatuses: ["RECEIVED"], targetStatus: "NORMALIZED",
  })

  const run = (enabled: boolean) => syncAcquisitionMailForCompany({
    companyId,
    connectionId: mailbox.id,
    mailShadow: false,
    consultationsAdmission: { db, env: { ...env, INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED: String(enabled) } },
    ingestion: {
      isEnabled: () => true,
      registerIncomingMessage: dependencies.legacy,
    },
    provider: {
      source: "GMAIL",
      listMessagesPage: async () => ({
        messages: [{
          externalMessageId, fromHeader: "Devis <devis@partenaire.example>",
          subject: "Consultation fictive Gmail", receivedAt: new Date("2026-01-01T12:00:00Z"),
          threadId: null, labels: [], snippet: null, attachments: [], providerMetadata: {},
        }],
        nextPageToken: null, nextHistoryId: "h1", hasMore: false, paginationMode: "lookback",
      }),
    },
    cursorRepository: new AcquisitionScanCursorRepository(db),
  })

  const before = writerCalls.legacy
  const first = await run(true)
  assert.equal(first.status, "SUCCESS")
  assert.equal(first.stats.ingested, 1)
  const saved = await db.acquisitionMessage.findFirstOrThrow({
    where: { companyId, externalMessageId }, include: { draft: true },
  })
  assert.equal(saved.sourceMailboxKey, mailbox.id)
  assert.equal(saved.resolvedPartnerId, partnerId)
  assert.ok(saved.draft)

  const replay = await run(true)
  assert.equal(replay.status, "SUCCESS")
  assert.equal(replay.stats.skippedDuplicate, 1)
  assert.equal(writerCalls.legacy, before)

  const rollback = await run(false)
  assert.equal(rollback.status, "SUCCESS")
  assert.equal(rollback.stats.skippedDuplicate, 1)
  assert.equal(writerCalls.legacy, before + 1)
  const drafts = await db.worksiteImportDraft.findMany({
    where: { companyId, acquisitionMessage: { externalMessageId } },
    select: { id: true },
  })
  assert.deepEqual(drafts, [{ id: saved.draft.id }])
  assert.equal(await db.acquisitionMessage.count({ where: { companyId, externalMessageId } }), 1)
  assert.deepEqual(await normalized.findById(companyId, oldProjection.id), oldProjection)
  assert.equal(await db.inboundEnvelope.count({ where: { companyId, connectionId, externalId: externalMessageId } }), 2)
  assert.equal(await db.routingDecision.count({
    where: { companyId, normalizedInbound: { envelope: { externalId: externalMessageId } }, outcome: "MATCH" },
  }), 1)
})

// ─── LOT-2 : référence de parité indépendante sous LOT-3 (règles historiques en lecture seule) ───────────────

const parityEnv = () => ({
  ...process.env,
  INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
  INTEGRATION_ROUTING_ENABLED: "true",
  INTEGRATION_ROUTING_SHADOW_ENABLED: "true",
  INTEGRATION_ROUTING_COMPANY_ALLOWLIST: companyId,
  INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED: "true",
})

async function admitViaGmail(externalMessageId: string, sender: string, options: Partial<Parameters<typeof admitGmailConsultation>[3]> = {}) {
  const mailbox = await db.acquisitionGmailConnection.findFirstOrThrow({ where: { companyId } })
  const canonical = {
    externalMessageId, fromHeader: sender, subject: "Consultation fictive", receivedAt: new Date("2026-01-02T12:00:00Z"),
    threadId: null, labels: [], snippet: null, attachments: [], providerMetadata: {},
  }
  const input = { ...message(externalMessageId), sourceMailboxKey: mailbox.id, senderEmail: sender }
  return admitGmailConsultation(canonical, input, dependencies.legacy, { db, env: parityEnv(), ...options })
}

async function observationFor(externalMessageId: string) {
  return db.routingParityObservation.findMany({ where: { companyId, externalIdHash: hashExternalId(externalMessageId) } })
}

it("parité : Router et règles historiques d'accord → PARITY_MATCH liée à la décision LOT-3, sans seconde décision", async () => {
  const id = "parite-accord"
  const r = await admitViaGmail(id, "Devis <devis@partenaire.example>")
  assert.equal(r.outcome, "DRAFT_CREATED")
  const [obs, ...rest] = await observationFor(id)
  assert.equal(rest.length, 0)
  assert.deepEqual([obs.legacyOutcome, obs.routerOutcome, obs.parityOutcome], ["ADMIT", "MATCH", "PARITY_MATCH"])
  const decisions = await db.routingDecision.findMany({ where: { companyId, normalizedInboundId: obs.normalizedInboundId! } })
  assert.deepEqual(decisions.map(d => d.id), [obs.routingDecisionId])
  // Rejeu : ni nouvelle décision ni nouvelle observation.
  await admitViaGmail(id, "Devis <devis@partenaire.example>")
  assert.equal((await observationFor(id)).length, 1)
  assert.equal(await db.routingDecision.count({ where: { companyId, normalizedInboundId: obs.normalizedInboundId! } }), 1)
})

it("parité : partenaire historique absent de la configuration Router → PARITY_LEGACY_ONLY ; LOT-3 n'admet toujours pas", async () => {
  const oublie = await db.acquisitionPartner.create({ data: { companyId, name: "Partenaire oublié", code: "oublie" } })
  await db.acquisitionPartnerDomain.create({ data: { companyId, partnerId: oublie.id, domainNormalized: "oublie.example" } })
  const id = "parite-legacy-seul"
  const partnersBefore = await db.acquisitionPartner.count({ where: { companyId } })
  assert.deepEqual(await admitViaGmail(id, "devis@oublie.example"), { outcome: "NOT_ADMITTED" })
  const [obs] = await observationFor(id)
  assert.deepEqual([obs.legacyOutcome, obs.routerOutcome, obs.parityOutcome, obs.explainedCodes], ["ADMIT", "NO_MATCH", "PARITY_LEGACY_ONLY", []])
  // La référence n'écrit rien : ni message, ni brouillon, ni partenaire.
  assert.equal(await db.acquisitionMessage.count({ where: { companyId, externalMessageId: id } }), 0)
  assert.equal(await db.acquisitionPartner.count({ where: { companyId } }), partnersBefore)
})

it("parité : expéditeur inconnu des deux côtés → PARITY_REJECT", async () => {
  const id = "parite-refus"
  assert.deepEqual(await admitViaGmail(id, "x@inconnu.example"), { outcome: "NOT_ADMITTED" })
  const [obs] = await observationFor(id)
  assert.deepEqual([obs.legacyOutcome, obs.routerOutcome, obs.parityOutcome], ["REJECT", "NO_MATCH", "PARITY_REJECT"])
})

it("parité : règle Router sans équivalent historique → PARITY_ROUTER_ONLY ; LOT-3 admet comme avant", async () => {
  const writes = new InboundSourceWriteService(new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db))
  await writes.createRule({ companyId, sourceId, type: "SENDER_DOMAIN", value: "routeur-seul.example" })
  const id = "parite-routeur-seul"
  const r = await admitViaGmail(id, "devis@routeur-seul.example")
  assert.equal(r.outcome, "DRAFT_CREATED")
  const [obs] = await observationFor(id)
  assert.deepEqual([obs.legacyOutcome, obs.routerOutcome, obs.parityOutcome], ["REJECT", "MATCH", "PARITY_ROUTER_ONLY"])
})

it("parité : référence ou observation en panne → décision LOT-3 inchangée", async () => {
  const brokenRef = await admitViaGmail("parite-ref-panne", "devis@partenaire.example", {
    legacyReference: { resolveEligibleSender: async () => { throw new Error("Panne fictive") } },
  })
  assert.equal(brokenRef.outcome, "DRAFT_CREATED")
  const [obs] = await observationFor("parite-ref-panne")
  assert.deepEqual([obs.legacyOutcome, obs.parityOutcome], ["UNKNOWN", "PARITY_UNCOMPARABLE"])
  const brokenParity = await admitViaGmail("parite-obs-panne", "devis@partenaire.example", {
    parity: { observe: async () => { throw new Error("Panne fictive") } },
  })
  assert.equal(brokenParity.outcome, "DRAFT_CREATED")
})

it("parité : lecteur historique qui ne répond jamais → admission rendue dans le budget, référence inconnue", async () => {
  const id = "parite-lecteur-bloque"
  let readerCalls = 0
  const started = Date.now()
  const r = await admitViaGmail(id, "devis@partenaire.example", {
    parityBudgetMs: 400,
    legacyReference: { resolveEligibleSender: () => { readerCalls++; return new Promise(() => undefined) } },
  })
  const elapsed = Date.now() - started
  assert.equal(r.outcome, "DRAFT_CREATED", "la décision LOT-3 n'attend pas la référence")
  assert.equal(readerCalls, 1)
  assert.ok(elapsed < 1_500, `attente bornée (${elapsed} ms)`)
  const [obs] = await observationFor(id)
  // Le budget unique est épuisé par l'attente : observation hors budget, sans second routage.
  assert.deepEqual(
    [obs.legacyOutcome, obs.routerOutcome, obs.parityOutcome, obs.comparisonCode],
    ["UNKNOWN", null, "PARITY_UNCOMPARABLE", "BUDGET_EXCEEDED"]
  )
  const saved = await db.acquisitionMessage.findFirstOrThrow({ where: { companyId, externalMessageId: id }, include: { draft: true } })
  assert.ok(saved.draft)
})

it("parité : observation qui ne termine jamais → admission rendue dans le budget", async () => {
  const budgetMs = 300
  // a) service d'observation entièrement bloqué
  let started = Date.now()
  const blockedObserve = await admitViaGmail("parite-observe-bloque", "devis@partenaire.example", {
    parityBudgetMs: budgetMs,
    parity: { observe: () => new Promise(() => undefined) },
  })
  let elapsed = Date.now() - started
  assert.equal(blockedObserve.outcome, "DRAFT_CREATED")
  assert.ok(elapsed < budgetMs + 500, `observe bloqué : ${elapsed} ms`)

  // b) vrai service shadow et vrai Router, seule l'écriture de l'observation ne répond jamais
  let recordCalls = 0
  const env = parityEnv()
  const id = "parite-record-bloque"
  started = Date.now()
  const blockedRecord = await admitViaGmail(id, "devis@partenaire.example", {
    parityBudgetMs: budgetMs,
    parity: new RoutingShadowService({
      env,
      log: () => undefined,
      router: new TenantRouterService({ normalized, config: new RoutingConfigSnapshotRepository(db), decisions: new RoutingDecisionRepository(db), env, log: () => undefined }),
      observations: { record: () => { recordCalls++; return new Promise(() => undefined) } },
      findNormalizedId: async (c, conn, key) => {
        const e = await envelopes.findByIdempotencyKey(c, conn, key)
        return (await normalized.findByEnvelopeVersion(c, e.id, "MESSAGE", "1.0.0")).id
      },
    }),
  })
  elapsed = Date.now() - started
  assert.equal(blockedRecord.outcome, "DRAFT_CREATED")
  assert.equal(recordCalls, 1, "l'écriture a bien été tentée")
  assert.ok(elapsed < budgetMs + 500, `écriture bloquée : ${elapsed} ms`)
  assert.equal((await observationFor(id)).length, 0)
  const saved = await db.acquisitionMessage.findFirstOrThrow({ where: { companyId, externalMessageId: id }, include: { draft: true } })
  assert.ok(saved.draft)
})

it("parité : shadow matching coupé → zéro lecture de référence, aucune observation, admission identique", async () => {
  for (const value of ["false", "", "TRUE"]) {
    const id = `parite-shadow-off-${value || "vide"}`
    let readerCalls = 0
    let observeCalls = 0
    const r = await admitViaGmail(id, "devis@partenaire.example", {
      env: { ...parityEnv(), INTEGRATION_ROUTING_SHADOW_ENABLED: value },
      legacyReference: { resolveEligibleSender: async () => { readerCalls++; return null } },
      parity: { observe: async () => { observeCalls++; return { status: "DISABLED" as const } } },
    })
    assert.equal(r.outcome, "DRAFT_CREATED")
    assert.deepEqual([readerCalls, observeCalls], [0, 0], `flag « ${value} »`)
    assert.equal((await observationFor(id)).length, 0)
  }
})
