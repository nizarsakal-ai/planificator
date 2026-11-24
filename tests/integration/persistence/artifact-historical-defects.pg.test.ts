/**
 * Ticket local « défauts historiques des workers contenu / pièces jointes, flag LOT-4B coupé ».
 * Tests DÉFENSIFS (caractérisation) sur PostgreSQL jetable : ils figent le comportement de main aujourd'hui,
 * pour qu'un correctif change seulement ce qui est voulu, et prouvent les garde-fous existants.
 *
 * D1 — exception de résolution de boîte (clé historique vide, lecture base en panne) : l'exception remonte,
 *      la pièce reste réservée (PENDING_DOWNLOAD) jusqu'à la récupération, sans perte ni appel fournisseur.
 * D2 — clé de boîte explicite d'une autre société : non vérifiée par le worker, mais l'adaptateur Gmail réel
 *      échoue sur la recherche du jeton (companyId + active) → GMAIL_NOT_CONNECTED, sans appel à Google.
 * Boîtes et jetons fictifs ; aucune I/O distante.
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
import { isRetryableAttachmentErrorCode } from "@/lib/acquisition/attachments/attachment-retry.policy"
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

describe("D1 — panne de lecture pendant la résolution de boîte (clé historique vide)", () => {
  it("pièce : l'exception remonte, la pièce reste réservée sans appel fournisseur, puis la récupération la libère", async () => {
    const f = await message(A, "", `d1-piece-${run}`)
    const calls: string[] = []
    const repository = new AcquisitionAttachmentRepository(db)
    await assert.rejects(
      downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
        db: flakyMailboxDb, repository, storage: storage(), log: () => undefined,
        gmailSource: { fetchAttachment: async () => { calls.push("fetch"); return { data: PDF, sizeBytes: PDF.length } } },
      }),
      /connexion base interrompue/
    )
    assert.deepEqual(calls, [], "aucun appel fournisseur")
    const held = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })
    assert.deepEqual([held.status, held.lastErrorCode, held.downloadRetryCount], ["PENDING_DOWNLOAD", null, 0])
    assert.ok(held.downloadClaimedAt, "réservation posée")
    // Comportement actuel : un second worker voit la pièce « en cours » jusqu'à la récupération.
    const second = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, { db, repository, storage: storage(), log: () => undefined })
    assert.equal(second.outcome, "ALREADY_IN_PROGRESS")
    // La récupération (TTL de réservation) la remet en DISCOVERED, puis le téléchargement réussit : aucune perte.
    assert.equal(await repository.reclaimPendingDownload({ companyId: A, attachmentId: f.attachmentId, olderThan: new Date(Date.now() + 1000) }), "RECLAIMED")
    const stored = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
      db, repository, storage: storage(), log: () => undefined,
      gmailSource: { fetchAttachment: async (i) => { assert.equal(i.connectionId, mailboxA); return { data: PDF, sizeBytes: PDF.length } } },
    })
    assert.equal(stored.outcome, "STORED", JSON.stringify(stored))
  })

  it("contenu : l'exception remonte au worker, rien n'est écrit, la lecture suivante réussit", async () => {
    const f = await message(A, "", `d1-corps-${run}`)
    const calls: string[] = []
    const source = { fetchMessageBody: async () => { calls.push("fetch"); return { textPlain: "Demande fictive", textHtml: null, mimeType: "text/plain", charset: "utf-8", providerMessageId: "x", byteLengthOriginal: 15 } } }
    await assert.rejects(fetchAndStoreMessageContentCore({ companyId: A, acquisitionMessageId: f.messageId }, { db: flakyMailboxDb, source }), /connexion base interrompue/)
    assert.deepEqual(calls, [])
    assert.equal(await db.acquisitionMessageContent.count({ where: { acquisitionMessageId: f.messageId } }), 0)
    const ok = await fetchAndStoreMessageContentCore({ companyId: A, acquisitionMessageId: f.messageId }, { db, source })
    assert.ok(ok.ok)
  })

  it("clé explicite : aucune lecture de boîte en base, donc pas d'exception possible à ce stade", async () => {
    const f = await message(A, mailboxA, `d1-explicite-${run}`)
    const r = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
      db: flakyMailboxDb, repository: new AcquisitionAttachmentRepository(db), storage: storage(), log: () => undefined,
      gmailSource: { fetchAttachment: async () => ({ data: PDF, sizeBytes: PDF.length }) },
    })
    assert.equal(r.outcome, "STORED", JSON.stringify(r))
  })
})

describe("D2 — clé de boîte explicite d'une autre société", () => {
  it("pièce : adaptateur Gmail réel → GMAIL_NOT_CONNECTED, aucun appel Google, boîte de B intacte ; code repris (comportement actuel)", async () => {
    const f = await message(A, mailboxB, `d2-piece-${run}`)
    const before = await db.acquisitionGmailConnection.findUniqueOrThrow({ where: { id: mailboxB } })
    const calls: string[] = []
    const adapter = new GmailAttachmentSourceAdapter(new PrismaAcquisitionGmailConnectionClient(db), countingGmail(calls))
    const r = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
      db, repository: new AcquisitionAttachmentRepository(db), storage: storage(), log: () => undefined, gmailSource: adapter,
    })
    assert.deepEqual([r.outcome, r.errorCode], ["FAILED", "GMAIL_NOT_CONNECTED"])
    assert.deepEqual(calls, [], "aucun appel à l'API Gmail")
    const afterRow = await db.acquisitionGmailConnection.findUniqueOrThrow({ where: { id: mailboxB } })
    assert.deepEqual([afterRow.accessToken, afterRow.updatedAt.getTime()], [before.accessToken, before.updatedAt.getTime()])
    // Comportement actuel à corriger : GMAIL_NOT_CONNECTED est repris, la pièce sera retentée jusqu'au plafond.
    assert.equal(isRetryableAttachmentErrorCode(r.errorCode), true)
    const row = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: f.attachmentId } })
    assert.ok(row.downloadNextRetryAt)
  })

  it("contenu : adaptateur Gmail réel → GMAIL_NOT_CONNECTED (CONFIG_TENANT), aucun appel Google", async () => {
    const f = await message(A, mailboxB, `d2-corps-${run}`)
    const calls: string[] = []
    const adapter = new GmailMessageContentSourceAdapter(new PrismaAcquisitionGmailConnectionClient(db), countingGmail(calls))
    const r = await fetchAndStoreMessageContentCore({ companyId: A, acquisitionMessageId: f.messageId }, { db, source: adapter })
    assert.ok(!r.ok)
    assert.equal(r.code, "GMAIL_NOT_CONNECTED")
    assert.equal(classifyContentFetchError(r.code), "CONFIG_TENANT")
    assert.deepEqual(calls, [])
  })

  it("témoin : la boîte de la bonne société est bien lue par l'adaptateur réel", async () => {
    const f = await message(A, mailboxA, `d2-temoin-${run}`)
    const calls: string[] = []
    const adapter = new GmailAttachmentSourceAdapter(new PrismaAcquisitionGmailConnectionClient(db), countingGmail(calls))
    const r = await downloadAcquisitionAttachment({ companyId: A, attachmentId: f.attachmentId }, {
      db, repository: new AcquisitionAttachmentRepository(db), storage: storage(), log: () => undefined, gmailSource: adapter,
    })
    assert.deepEqual(calls, ["getAttachment"])
    assert.equal(r.outcome, "STORED", JSON.stringify(r))
  })
})
