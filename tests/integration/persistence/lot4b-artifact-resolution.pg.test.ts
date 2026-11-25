/**
 * LOT-4B — recette PostgreSQL jetable depuis la VRAIE admission LOT-3 (`admitGmailConsultation`), puis lecture du
 * corps (`fetchAndStoreMessageContentCore`) et téléchargement de la pièce (`downloadAcquisitionAttachment`).
 * Boîtes, connecteurs, fournisseurs et stockage fictifs. Aucune I/O distante.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { admitGmailConsultation } from "@/lib/acquisition/admission/gmail-consultations-admission"
import { fetchAndStoreMessageContentCore } from "@/lib/acquisition/content/message-content.service"
import { classifyContentFetchError } from "@/lib/acquisition/content/message-content-fetch-error-policy"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { isRetryableAttachmentErrorCode } from "@/lib/acquisition/attachments/attachment-retry.policy"
import type { AttachmentSourcePort } from "@/lib/acquisition/attachments/attachment-source.port"
import type { AttachmentStoragePort } from "@/lib/acquisition/attachments/attachment-storage.port"
import type { AcquisitionMessageContentSourcePort } from "@/lib/acquisition/content/message-content-source.port"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { PipelineBindingRepository } from "@/lib/integration/persistence/pipeline-binding.repository"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) { console.error("Tests PG LOT-4B : fournir TEST_INTEGRATION_DATABASE_URL."); process.exit(1) }
assertSafeDisposableTestDatabaseUrl(resolved.url)
const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
const run = Math.random().toString(36).slice(2, 8)
const PDF = Buffer.from("%PDF-1.4 piece fictive LOT-4B")
const SENDER = "devis@partenaire-fictif.example"

let A = "", B = "", partnerA = "", sourceA = ""
const mailboxes: Record<string, string> = {}
const connections: Record<string, string> = {}

const baseEnv = (companyId: string) => ({
  ...process.env,
  INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
  INTEGRATION_ROUTING_ENABLED: "true",
  INTEGRATION_ROUTING_COMPANY_ALLOWLIST: companyId,
  INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED: "true",
})
const flagOn = (companyId: string) => ({
  ...baseEnv(companyId),
  INTEGRATION_ARTIFACT_RESOLUTION_ENABLED: "true",
  INTEGRATION_ARTIFACT_RESOLUTION_COMPANY_ALLOWLIST: companyId,
})

async function addMailbox(companyId: string, key: string, partnerId: string, sourceId: string) {
  const mailbox = await db.acquisitionGmailConnection.create({
    data: {
      companyId, gmailAddress: `${key}-${run}@boite-fictive.example`, accessToken: "fixture", refreshToken: "fixture",
      tokenExpiry: new Date("2027-01-01T00:00:00Z"), connectedById: "utilisateur-fictif",
    },
  })
  const connection = await db.integrationConnection.create({
    data: {
      companyId, connectorType: "platform.mail.legacy", displayName: `Connexion fictive ${key}`, status: "ACTIVE",
      secretBackend: "LEGACY_GMAIL", config: { gmailMailboxId: mailbox.id, sourcePartners: [{ sourceId, partnerId }] },
    },
  })
  mailboxes[key] = mailbox.id
  connections[key] = connection.id
}

async function seedCompany(label: string) {
  const companyId = (await db.company.create({ data: { name: `LOT-4B ${label} ${run}`, slug: `lot4b-${label}-${run}` } })).id
  const partnerId = (await db.acquisitionPartner.create({ data: { companyId, name: "Partenaire fictif", code: `fictif-${label}` } })).id
  await db.acquisitionPartnerDomain.create({ data: { companyId, partnerId, domainNormalized: "partenaire-fictif.example" } })
  const writes = new InboundSourceWriteService(new InboundSourceRepository(db), new InboundSourceRuleRepository(db), new InboundSourceIdentityTx(db))
  const sourceId = (await writes.createSource({ companyId, displayName: "Source fictive" })).id
  await writes.createRule({ companyId, sourceId, type: "SENDER_DOMAIN", value: "partenaire-fictif.example" })
  const bindings = new PipelineBindingRepository(db)
  const binding = await bindings.create({ companyId, sourceId })
  await bindings.setEnabled(companyId, binding.id, true)
  await writes.setSourceEnabled(companyId, sourceId, true)
  return { companyId, partnerId, sourceId }
}

/** Admission LOT-3 réelle d'un message fictif avec une pièce jointe. */
async function admit(companyId: string, mailboxKey: string, externalMessageId: string) {
  const mailboxId = mailboxes[mailboxKey]!
  const input: RegisterIncomingMessageInput = {
    companyId, source: "GMAIL", sourceMailboxKey: mailboxId, externalMessageId, senderEmail: SENDER,
    subject: "Consultation fictive", receivedAt: new Date("2026-11-24T10:00:00Z"),
    attachments: [{ externalAttachmentId: `piece-${externalMessageId}`, filename: "plan-fictif.pdf", mimeType: "application/pdf", sizeBytes: PDF.length }],
  }
  const result = await admitGmailConsultation({
    externalMessageId, fromHeader: `Devis <${SENDER}>`, subject: "Consultation fictive", receivedAt: input.receivedAt,
    threadId: null, labels: [], snippet: null, attachments: [], providerMetadata: {},
  }, input, (i) => registerIncomingMessage(i, db), { db, env: baseEnv(companyId) })
  assert.equal(result.outcome, "DRAFT_CREATED", "admission LOT-3 réelle")
  const message = await db.acquisitionMessage.findFirstOrThrow({ where: { companyId, externalMessageId }, include: { attachments: true } })
  return { messageId: message.id, attachmentId: message.attachments[0]!.id, mailboxId }
}

function contentSource(calls: { companyId: string; connectionId?: string; externalMessageId: string }[]): AcquisitionMessageContentSourcePort {
  return {
    fetchMessageBody: async (input) => {
      calls.push({ companyId: input.companyId, connectionId: input.connectionId, externalMessageId: input.externalMessageId })
      return { textPlain: "Demande de devis fictive", textHtml: null, mimeType: "text/plain", charset: "utf-8", providerMessageId: input.externalMessageId, byteLengthOriginal: 24 }
    },
  }
}
function attachmentSource(calls: { connectionId?: string; externalAttachmentId: string }[]): AttachmentSourcePort {
  return {
    fetchAttachment: async (input) => {
      calls.push({ connectionId: input.connectionId, externalAttachmentId: input.externalAttachmentId })
      return { data: PDF, sizeBytes: PDF.length }
    },
  }
}
function storage(): AttachmentStoragePort {
  let n = 0
  return {
    store: async (i) => ({ storageUrl: `https://stockage-fictif.test/${i.attachmentId}`, storagePublicId: `fictif/${i.companyId}/${i.attachmentId}/${++n}`, created: true }),
    destroy: async () => undefined,
  }
}

async function readBoth(companyId: string, f: { messageId: string; attachmentId: string }, env: NodeJS.ProcessEnv, logs: Record<string, unknown>[] = [], dbOverride: PrismaClient = db) {
  const contentCalls: { companyId: string; connectionId?: string; externalMessageId: string }[] = []
  const attachmentCalls: { connectionId?: string; externalAttachmentId: string }[] = []
  const content = await fetchAndStoreMessageContentCore(
    { companyId, acquisitionMessageId: f.messageId },
    { db: dbOverride, env, artifactLog: (x) => logs.push(x), source: contentSource(contentCalls) }
  )
  const attachment = await downloadAcquisitionAttachment(
    { companyId, attachmentId: f.attachmentId },
    { db: dbOverride, env, artifactLog: (x) => logs.push(x), repository: new AcquisitionAttachmentRepository(db), storage: storage(), log: () => undefined, source: attachmentSource(attachmentCalls) }
  )
  return { content, attachment, contentCalls, attachmentCalls }
}

before(async () => {
  process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
  process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
  const a = await seedCompany("a")
  A = a.companyId; partnerA = a.partnerId; sourceA = a.sourceId
  await addMailbox(A, "a1", partnerA, sourceA)
  await addMailbox(A, "a2", partnerA, sourceA)
  const b = await seedCompany("b")
  B = b.companyId
  await addMailbox(B, "b1", b.partnerId, b.sourceId)
})
after(async () => {
  await db.company.deleteMany({ where: { id: { in: [A, B].filter(Boolean) } } })
  await db.$disconnect()
})

describe("LOT-4B depuis l'admission LOT-3 réelle", () => {
  it("flag coupé et flag posé : mêmes sorties (statuts, empreinte, taille, boîte) ; chemin LEGACY puis PLATFORM", async () => {
    const off = await readBoth(A, await admit(A, "a1", `off-${run}`), baseEnv(A))
    const logs: Record<string, unknown>[] = []
    const on = await readBoth(A, await admit(A, "a1", `on-${run}`), flagOn(A), logs)
    for (const r of [off, on]) {
      assert.ok(r.content.ok, JSON.stringify(r.content))
      assert.equal(r.attachment.outcome, "STORED", JSON.stringify(r.attachment))
    }
    assert.ok(off.content.ok && on.content.ok)
    assert.deepEqual(
      [on.content.outcome, on.content.content.normalizedText, on.content.content.contentHash, on.attachment.sha256],
      [off.content.outcome, off.content.content.normalizedText, off.content.content.contentHash, off.attachment.sha256]
    )
    assert.deepEqual([off.contentCalls[0]!.connectionId, on.contentCalls[0]!.connectionId], [mailboxes.a1, mailboxes.a1])
    assert.deepEqual([off.attachmentCalls.length, on.attachmentCalls.length], [1, 1])
    const stored = await db.acquisitionAttachment.findMany({ where: { id: { in: [off.attachment.attachmentId, on.attachment.attachmentId] } } })
    assert.deepEqual(stored.map((s) => [s.status, s.sizeBytes]), [["STORED", PDF.length], ["STORED", PDF.length]])
    assert.deepEqual(logs.map((l) => [l.capability, l.path, l.outcome]), [["CONTENT_FETCH", "PLATFORM", "RESOLVED"], ["ARTIFACT_FETCH", "PLATFORM", "RESOLVED"]])
  })

  it("deux boîtes distinctes de la même société : chaque message lu par sa propre boîte", async () => {
    const one = await readBoth(A, await admit(A, "a1", `m1-${run}`), flagOn(A))
    const two = await readBoth(A, await admit(A, "a2", `m2-${run}`), flagOn(A))
    assert.deepEqual(
      [one.contentCalls[0]!.connectionId, one.attachmentCalls[0]!.connectionId, two.contentCalls[0]!.connectionId, two.attachmentCalls[0]!.connectionId],
      [mailboxes.a1, mailboxes.a1, mailboxes.a2, mailboxes.a2]
    )
    assert.equal(two.attachment.outcome, "STORED")
  })

  it("refus intersociété avant tout appel fournisseur : message de B pointant vers la boîte de A", async () => {
    const id = `xt-${run}`
    const reg = await registerIncomingMessage({
      companyId: B, source: "GMAIL", sourceMailboxKey: mailboxes.a1!, externalMessageId: id, senderEmail: SENDER,
      subject: "Consultation fictive", receivedAt: new Date(),
      attachments: [{ externalAttachmentId: "piece-xt", filename: "plan-fictif.pdf", mimeType: "application/pdf", sizeBytes: PDF.length }],
    }, db)
    const attachmentId = (await db.acquisitionAttachment.findFirstOrThrow({ where: { companyId: B, acquisitionMessageId: reg.messageId } })).id
    const logs: Record<string, unknown>[] = []
    const r = await readBoth(B, { messageId: reg.messageId, attachmentId }, flagOn(B), logs)
    assert.deepEqual([r.contentCalls.length, r.attachmentCalls.length], [0, 0], "aucun appel fournisseur")
    assert.ok(!r.content.ok && r.content.code === "ARTIFACT_CAPABILITY_UNAVAILABLE")
    assert.equal(r.attachment.errorCode, "ARTIFACT_CAPABILITY_UNAVAILABLE")
    assert.ok(logs.every((l) => l.reason === "MAILBOX_NOT_OWNED"))
  })

  it("connexion d'intégration désactivée après admission : refus des deux lectures, sans appel fournisseur", async () => {
    const f = await admit(A, "a2", `off-conn-${run}`)
    await db.integrationConnection.update({ where: { id: connections.a2! }, data: { status: "DISABLED" } })
    try {
      const logs: Record<string, unknown>[] = []
      const r = await readBoth(A, f, flagOn(A), logs)
      assert.deepEqual([r.contentCalls.length, r.attachmentCalls.length], [0, 0])
      assert.ok(!r.content.ok && r.content.code === "ARTIFACT_CAPABILITY_UNAVAILABLE")
      assert.equal(r.attachment.errorCode, "ARTIFACT_CAPABILITY_UNAVAILABLE")
      assert.equal(isRetryableAttachmentErrorCode(r.attachment.errorCode), false)
      assert.ok(logs.every((l) => l.reason === "CONNECTION_INVALID"))
      // Flag coupé : comportement courant, la lecture historique a lieu.
      const legacy = await readBoth(A, { ...f, attachmentId: f.attachmentId }, baseEnv(A))
      assert.equal(legacy.contentCalls.length, 1)
    } finally {
      await db.integrationConnection.update({ where: { id: connections.a2! }, data: { status: "ACTIVE" } })
    }
  })

  it("panne transitoire de lecture : ARTIFACT_RESOLUTION_FAILED, repris pour le contenu et la pièce, sans appel fournisseur", async () => {
    const f = await admit(A, "a1", `panne-${run}`)
    const flaky = new Proxy(db, {
      get: (target, prop, receiver) => prop === "inboundEnvelope"
        ? { findMany: async () => { throw new Error("connexion base interrompue (fictif)") } }
        : Reflect.get(target, prop, receiver),
    }) as PrismaClient
    const logs: Record<string, unknown>[] = []
    const r = await readBoth(A, f, flagOn(A), logs, flaky)
    assert.deepEqual([r.contentCalls.length, r.attachmentCalls.length], [0, 0])
    assert.ok(!r.content.ok && r.content.code === "ARTIFACT_RESOLUTION_FAILED")
    assert.equal(classifyContentFetchError(r.content.code), "RETRYABLE")
    assert.equal(r.attachment.errorCode, "ARTIFACT_RESOLUTION_FAILED")
    const row = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })
    assert.equal(row.lastErrorCode, "ARTIFACT_RESOLUTION_FAILED")
    assert.ok(row.downloadNextRetryAt, "une reprise est planifiée")
    assert.deepEqual(logs.map((l) => [l.outcome, l.reason]), [["ARTIFACT_RESOLUTION_FAILED", "READ_FAILED"], ["ARTIFACT_RESOLUTION_FAILED", "READ_FAILED"]])
    // Reprise du contenu une fois la base revenue (la pièce, elle, est reprise par l'orchestrateur à l'échéance).
    const retry = await fetchAndStoreMessageContentCore(
      { companyId: A, acquisitionMessageId: f.messageId },
      { db, env: flagOn(A), artifactLog: () => undefined, source: contentSource([]) }
    )
    assert.ok(retry.ok)
  })

  it("message historique sans admission, flag posé : repli historique journalisé ; journaux sans donnée personnelle", async () => {
    const id = `hist-${run}`
    const reg = await registerIncomingMessage({
      companyId: A, source: "GMAIL", sourceMailboxKey: mailboxes.a1!, externalMessageId: id, senderEmail: SENDER,
      subject: "Objet confidentiel fictif", receivedAt: new Date(),
      attachments: [{ externalAttachmentId: "piece-hist", filename: "nom-de-fichier-secret.pdf", mimeType: "application/pdf", sizeBytes: PDF.length }],
    }, db)
    const attachmentId = (await db.acquisitionAttachment.findFirstOrThrow({ where: { companyId: A, acquisitionMessageId: reg.messageId } })).id
    const logs: Record<string, unknown>[] = []
    const r = await readBoth(A, { messageId: reg.messageId, attachmentId }, flagOn(A), logs)
    assert.ok(r.content.ok)
    assert.equal(r.attachment.outcome, "STORED")
    assert.deepEqual(logs.map((l) => l.path), ["LEGACY_FALLBACK", "LEGACY_FALLBACK"])
    const all = JSON.stringify(logs)
    for (const secret of [id, "piece-hist", "nom-de-fichier-secret", "Objet confidentiel", SENDER, "partenaire-fictif", mailboxes.a1!, "boite-fictive"]) {
      assert.ok(!all.includes(secret), `journal sans « ${secret} »`)
    }
  })
})
