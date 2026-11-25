/**
 * Ticket « défauts historiques des workers contenu / pièces jointes » — CORRIGÉ. PostgreSQL jetable, connecteurs,
 * boîtes et jetons fictifs ; chaque cas est joué sur les deux chemins (flag LOT-4B coupé et posé).
 *
 * D1 — panne de lecture pendant la résolution de boîte : ARTIFACT_RESOLUTION_FAILED au lieu d'une exception ;
 *      la pièce passe en FAILED avec reprise planifiée (plus jamais laissée réservée), puis est reprise jusqu'à STORED.
 * D2 — clé de boîte explicite d'une autre société : refus MAILBOX_NOT_OWNED, non repris, avant toute lecture de
 *      jeton et tout appel Google ; une boîte inactive de la bonne société garde son échec habituel.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.GMAIL_TOKEN_ENCRYPTION_KEY ??= "test-encryption-key-32chars-min!!"

import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { encrypt } from "@/lib/encryption"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { GmailAttachmentSourceAdapter } from "@/lib/acquisition/attachments/gmail-attachment-source.adapter"
import { RETRYABLE_ATTACHMENT_ERROR_CODES, isRetryableAttachmentErrorCode } from "@/lib/acquisition/attachments/attachment-retry.policy"
import type { AttachmentStoragePort } from "@/lib/acquisition/attachments/attachment-storage.port"
import { fetchAndStoreMessageContentCore } from "@/lib/acquisition/content/message-content.service"
import { GmailMessageContentSourceAdapter } from "@/lib/acquisition/content/gmail-message-content-source.adapter"
import { classifyContentFetchError } from "@/lib/acquisition/content/message-content-fetch-error-policy"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { seedLauraluPartnerForCompany } from "../../acquisition/helpers/seed-lauralu-partner"
import { assertSafeDisposableTestDatabaseUrl, resolveIntegrationTestDatabaseUrl } from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) { console.error("Tests PG défauts historiques : fournir TEST_INTEGRATION_DATABASE_URL."); process.exit(1) }
assertSafeDisposableTestDatabaseUrl(resolved.url)
const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
const run = Math.random().toString(36).slice(2, 8)
const PDF = Buffer.from("%PDF-1.4 piece fictive historique")
let A = "", B = "", mailboxA = "", mailboxB = ""

async function mailbox(companyId: string, key: string) {
  return (await db.acquisitionGmailConnection.create({
    data: {
      companyId, gmailAddress: `${key}-${run}@boite-fictive.example`, accessToken: encrypt("jeton-fictif"), refreshToken: encrypt("jeton-fictif"),
      tokenExpiry: new Date(Date.now() + 24 * 3600_000), connectedById: "utilisateur-fictif",
    },
  })).id
}
async function message(companyId: string, sourceMailboxKey: string, externalMessageId: string) {
  const reg = await registerIncomingMessage({
    companyId, source: "GMAIL", sourceMailboxKey, externalMessageId, senderEmail: "user@lauralu.fr",
    subject: "Consultation fictive", receivedAt: new Date(),
    attachments: [{ externalAttachmentId: `piece-${externalMessageId}`, filename: "plan-fictif.pdf", mimeType: "application/pdf", sizeBytes: PDF.length }],
  }, db)
  assert.equal(reg.outcome, "DRAFT_CREATED")
  const attachmentId = (await db.acquisitionAttachment.findFirstOrThrow({ where: { companyId, acquisitionMessageId: reg.messageId } })).id
  return { messageId: reg.messageId, attachmentId }
}
function storage(): AttachmentStoragePort {
  return {
    store: async (i) => ({ storageUrl: `https://stockage-fictif.test/${i.attachmentId}`, storagePublicId: `fictif/${i.attachmentId}`, created: true }),
    destroy: async () => undefined,
  }
}
/** Client Gmail fictif : compte tout appel ; ne doit jamais être appelé dans les cas de refus. */
function countingGmail(calls: string[]): GmailApiClient {
  return new Proxy({} as GmailApiClient, {
    get: (_t, prop) => async () => {
      calls.push(String(prop))
      if (prop === "getAttachment") return { data: PDF.toString("base64url"), size: PDF.length }
      throw new Error("appel Gmail inattendu")
    },
  })
}
/** Base dont la lecture des boîtes Acquisition tombe en panne (fictif) ; tout le reste fonctionne. */
const flakyMailboxDb = new Proxy(db, {
  get: (target, prop, receiver) => prop === "acquisitionGmailConnection"
    ? new Proxy(target.acquisitionGmailConnection, {
      get: (t, p, r) => p === "findMany" ? async () => { throw new Error("connexion base interrompue (fictif)") } : Reflect.get(t, p, r),
    })
    : Reflect.get(target, prop, receiver),
}) as PrismaClient

before(async () => {
  process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
  process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
  A = (await db.company.create({ data: { name: `Hist A ${run}`, slug: `hist-a-${run}` } })).id
  B = (await db.company.create({ data: { name: `Hist B ${run}`, slug: `hist-b-${run}` } })).id
  await seedLauraluPartnerForCompany(db, A)
  await seedLauraluPartnerForCompany(db, B)
  mailboxA = await mailbox(A, "a")
  mailboxB = await mailbox(B, "b")
})
after(async () => {
  await db.company.deleteMany({ where: { id: { in: [A, B].filter(Boolean) } } })
  await db.$disconnect()
})

/** Les deux chemins : flag LOT-4B coupé (défaut) et posé pour la société A. */
const PATHS = [
  { name: "flag coupé", env: (_c: string): NodeJS.ProcessEnv => ({ ...process.env }) },
  { name: "flag posé", env: (c: string): NodeJS.ProcessEnv => ({
    ...process.env, INTEGRATION_PLATFORM_FOUNDATION_ENABLED: "true",
    INTEGRATION_ARTIFACT_RESOLUTION_ENABLED: "true", INTEGRATION_ARTIFACT_RESOLUTION_COMPANY_ALLOWLIST: c,
  }) },
]
const quiet = () => undefined
/** Base dont la vérification d'appartenance d'une boîte (findFirst) tombe en panne (fictif). */
const flakyOwnershipDb = new Proxy(db, {
  get: (target, prop, receiver) => prop === "acquisitionGmailConnection"
    ? new Proxy(target.acquisitionGmailConnection, {
      get: (t, p, r) => p === "findFirst" ? async () => { throw new Error("connexion base interrompue (fictif)") } : Reflect.get(t, p, r),
    })
    : Reflect.get(target, prop, receiver),
}) as PrismaClient

for (const path of PATHS) {
  describe(`D1 corrigé (${path.name}) — panne de lecture pendant la résolution de boîte`, () => {
    it("pièce, clé vide : FAILED + ARTIFACT_RESOLUTION_FAILED, reprise planifiée, jamais laissée réservée, 0 appel fournisseur ; puis reprise complète jusqu'à STORED", async () => {
      const f = await message(A, "", `d1-piece-${path.name}-${run}`)
      const calls: string[] = []
      const repository = new AcquisitionAttachmentRepository(db)
      const failed = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
        db: flakyMailboxDb, env: path.env(A), artifactLog: quiet, repository, storage: storage(), log: quiet,
        gmailSource: { fetchAttachment: async () => { calls.push("fetch"); return { data: PDF, sizeBytes: PDF.length } } },
      })
      assert.deepEqual([failed.outcome, failed.errorCode], ["FAILED", "ARTIFACT_RESOLUTION_FAILED"])
      assert.deepEqual(calls, [], "aucun appel fournisseur")
      const row = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })
      assert.deepEqual([row.status, row.lastErrorCode, row.downloadClaimedAt], ["FAILED", "ARTIFACT_RESOLUTION_FAILED", null])
      assert.ok(row.downloadRetryCount >= 1, "essai compté")
      assert.ok(row.downloadNextRetryAt, "reprise planifiée")
      assert.equal(isRetryableAttachmentErrorCode(failed.errorCode), true)
      const retry = (now: Date) => repository.scheduleRetryToDiscovered({
        companyId: A, attachmentId: f.attachmentId, now, maxRetries: 5, retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
      })
      // Avant l'échéance : aucune reprise. À l'échéance, base revenue : DISCOVERED puis STORED par la bonne boîte.
      assert.equal(await retry(new Date(row.downloadNextRetryAt!.getTime() - 1000)), "NOOP")
      assert.equal(await retry(new Date(row.downloadNextRetryAt!.getTime() + 1000)), "TRANSITIONED")
      const stored = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
        db, env: path.env(A), artifactLog: quiet, repository, storage: storage(), log: quiet,
        gmailSource: { fetchAttachment: async (i) => { assert.equal(i.connectionId, mailboxA); return { data: PDF, sizeBytes: PDF.length } } },
      })
      assert.equal(stored.outcome, "STORED", JSON.stringify(stored))
    })

    it("pièce, clé explicite : panne de la vérification d'appartenance → même reprise, 0 appel fournisseur", async () => {
      const f = await message(A, mailboxA, `d1-explicite-${path.name}-${run}`)
      const calls: string[] = []
      const r = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
        db: flakyOwnershipDb, env: path.env(A), artifactLog: quiet, repository: new AcquisitionAttachmentRepository(db), storage: storage(), log: quiet,
        gmailSource: { fetchAttachment: async () => { calls.push("fetch"); return { data: PDF, sizeBytes: PDF.length } } },
      })
      assert.deepEqual([r.outcome, r.errorCode, calls.length], ["FAILED", "ARTIFACT_RESOLUTION_FAILED", 0])
    })

    it("contenu : ARTIFACT_RESOLUTION_FAILED (RETRYABLE) au lieu d'une exception, rien n'est écrit, la lecture suivante réussit", async () => {
      const f = await message(A, "", `d1-corps-${path.name}-${run}`)
      const calls: string[] = []
      const source = { fetchMessageBody: async () => { calls.push("fetch"); return { textPlain: "Demande fictive", textHtml: null, mimeType: "text/plain", charset: "utf-8", providerMessageId: "x", byteLengthOriginal: 15 } } }
      const r = await fetchAndStoreMessageContentCore({ companyId: A, acquisitionMessageId: f.messageId }, { db: flakyMailboxDb, env: path.env(A), artifactLog: quiet, source })
      assert.ok(!r.ok)
      assert.equal(r.code, "ARTIFACT_RESOLUTION_FAILED")
      assert.equal(classifyContentFetchError(r.code), "RETRYABLE")
      assert.deepEqual(calls, [])
      assert.equal(await db.acquisitionMessageContent.count({ where: { acquisitionMessageId: f.messageId } }), 0)
      const ok = await fetchAndStoreMessageContentCore({ companyId: A, acquisitionMessageId: f.messageId }, { db, env: path.env(A), artifactLog: quiet, source })
      assert.ok(ok.ok)
    })
  })

  describe(`D2 corrigé (${path.name}) — clé de boîte explicite d'une autre société`, () => {
    it("pièce : refus MAILBOX_NOT_OWNED non repris, avant toute lecture de jeton ; aucun appel Google ; boîte de B intacte", async () => {
      const f = await message(A, mailboxB, `d2-piece-${path.name}-${run}`)
      const before = await db.acquisitionGmailConnection.findUniqueOrThrow({ where: { id: mailboxB } })
      const calls: string[] = []
      const tokenLookups: string[] = []
      const tokenClient = new PrismaAcquisitionGmailConnectionClient(db)
      const spiedClient = {
        getValidAccessToken: (l: Parameters<typeof tokenClient.getValidAccessToken>[0]) => { tokenLookups.push("token"); return tokenClient.getValidAccessToken(l) },
      }
      const adapter = new GmailAttachmentSourceAdapter(spiedClient as never, countingGmail(calls))
      const logs: Record<string, unknown>[] = []
      const r = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
        db, env: path.env(A), artifactLog: (x) => logs.push(x), repository: new AcquisitionAttachmentRepository(db), storage: storage(), log: quiet, gmailSource: adapter,
      })
      assert.deepEqual([r.outcome, r.errorCode], ["FAILED", "ARTIFACT_CAPABILITY_UNAVAILABLE"])
      assert.deepEqual([calls, tokenLookups], [[], []], "ni jeton lu ni appel Gmail")
      assert.equal(isRetryableAttachmentErrorCode(r.errorCode), false)
      const row = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })
      assert.deepEqual([row.status, row.downloadNextRetryAt], ["FAILED", null], "aucune reprise planifiée")
      const afterRow = await db.acquisitionGmailConnection.findUniqueOrThrow({ where: { id: mailboxB } })
      assert.deepEqual([afterRow.accessToken, afterRow.updatedAt.getTime()], [before.accessToken, before.updatedAt.getTime()])
      assert.deepEqual(logs.map((l) => l.reason), ["MAILBOX_NOT_OWNED"])
      assert.ok(!JSON.stringify(logs).includes(mailboxB), "identifiant de boîte absent du journal")
    })

    it("contenu : refus MAILBOX_NOT_OWNED (CONFIG_TENANT), aucun appel Google", async () => {
      const f = await message(A, mailboxB, `d2-corps-${path.name}-${run}`)
      const calls: string[] = []
      const adapter = new GmailMessageContentSourceAdapter(new PrismaAcquisitionGmailConnectionClient(db), countingGmail(calls))
      const r = await fetchAndStoreMessageContentCore({ companyId: A, acquisitionMessageId: f.messageId }, { db, env: path.env(A), artifactLog: quiet, source: adapter })
      assert.ok(!r.ok)
      assert.equal(r.code, "ARTIFACT_CAPABILITY_UNAVAILABLE")
      assert.equal(classifyContentFetchError(r.code), "CONFIG_TENANT")
      assert.deepEqual(calls, [])
    })

    it("témoin : la boîte de la bonne société est lue par l'adaptateur réel", async () => {
      const f = await message(A, mailboxA, `d2-temoin-${path.name}-${run}`)
      const calls: string[] = []
      const adapter = new GmailAttachmentSourceAdapter(new PrismaAcquisitionGmailConnectionClient(db), countingGmail(calls))
      const r = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
        db, env: path.env(A), artifactLog: quiet, repository: new AcquisitionAttachmentRepository(db), storage: storage(), log: quiet, gmailSource: adapter,
      })
      assert.deepEqual(calls, ["getAttachment"])
      assert.equal(r.outcome, "STORED", JSON.stringify(r))
    })

    it("boîte inactive de la bonne société : échec habituel GMAIL_NOT_CONNECTED conservé (contrôle d'appartenance seule)", async () => {
      const inactive = await mailbox(A, `inactive-${path.name === "flag coupé" ? "off" : "on"}`)
      await db.acquisitionGmailConnection.update({ where: { id: inactive }, data: { active: false } })
      const f = await message(A, inactive, `d2-inactive-${path.name}-${run}`)
      const calls: string[] = []
      const adapter = new GmailMessageContentSourceAdapter(new PrismaAcquisitionGmailConnectionClient(db), countingGmail(calls))
      const r = await fetchAndStoreMessageContentCore({ companyId: A, acquisitionMessageId: f.messageId }, { db, env: path.env(A), artifactLog: quiet, source: adapter })
      assert.ok(!r.ok)
      assert.equal(r.code, "GMAIL_NOT_CONNECTED")
      assert.deepEqual(calls, [])
    })
  })
}
