// Tests d'intégration — idempotence, isolation multi-tenant, rollback.
//
// Nécessitent une base PostgreSQL JETABLE (jamais la production) :
//   TEST_ACQUISITION_DATABASE_URL="postgresql://..." npm run test:acquisition
//
// Recommandé : une branche Neon dédiée « tests » (créée depuis la console
// Neon), sur laquelle on applique d'abord le schéma :
//   DATABASE_URL=$TEST_ACQUISITION_DATABASE_URL npx prisma db push
//
// Sans cette variable, ces tests sont ignorés proprement (skip) — seuls les
// tests unitaires s'exécutent.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import {
  registerIncomingMessage,
  getImportDraftForCompany,
} from "@/lib/acquisition/acquisition.service"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

let companyA = ""
let companyB = ""

const baseInput = (companyId: string, externalMessageId: string, senderEmail: string) => ({
  companyId,
  source: "GMAIL" as const,
  externalMessageId,
  senderEmail,
  subject: "Consultation LAURALU — chantier test",
  receivedAt: new Date(),
  attachments: [
    { externalAttachmentId: "att-1", filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 1234 },
    { externalAttachmentId: "att-2", filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 999 },
  ],
})

describe("acquisition — intégration (BDD de test)", RUN, () => {
  before(async () => {
    const a = await db.company.create({
      data: { name: "Test Acq A", slug: `test-acq-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Test Acq B", slug: `test-acq-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id
  })

  after(async () => {
    // Cascade : supprime messages, brouillons et pièces jointes de test.
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("crée un brouillon pour un message admissible (message + PJ + draft)", async () => {
    const r = await registerIncomingMessage(baseInput(companyA, "msg-ok-1", "carlenebourgine@lauralu.fr"), db)
    assert.equal(r.created, true)
    assert.equal(r.outcome, "DRAFT_CREATED")
    assert.ok(r.draftId)

    const msg = await db.acquisitionMessage.findFirst({
      where: { id: r.messageId, companyId: companyA },
      include: { attachments: true, draft: true },
    })
    assert.equal(msg?.status, "DRAFT_CREATED")
    assert.equal(msg?.senderDomain, "lauralu.fr")
    assert.equal(msg?.attachments.length, 2)
    assert.equal(msg?.draft?.status, "PENDING_EXTRACTION")
    // Pièces jointes reliées au bon message ET au bon tenant
    assert.ok(msg?.attachments.every((a) => a.companyId === companyA && a.acquisitionMessageId === msg.id))
  })

  it("ne crée aucun brouillon pour un expéditeur non admissible", async () => {
    const r = await registerIncomingMessage(baseInput(companyA, "msg-rej-1", "user@gmail.com"), db)
    assert.equal(r.outcome, "REJECTED")
    assert.equal(r.draftId, null)
    const drafts = await db.worksiteImportDraft.count({
      where: { companyId: companyA, acquisitionMessage: { externalMessageId: "msg-rej-1" } },
    })
    assert.equal(drafts, 0)
    const msg = await db.acquisitionMessage.findFirst({
      where: { companyId: companyA, externalMessageId: "msg-rej-1" },
    })
    assert.equal(msg?.status, "REJECTED")
  })

  it("deux appels identiques ne créent qu'un message, un brouillon et 2 PJ", async () => {
    const input = baseInput(companyA, "msg-idem-1", "elodieagez@lauralu.fr")
    const r1 = await registerIncomingMessage(input, db)
    const r2 = await registerIncomingMessage(input, db)
    assert.equal(r1.created, true)
    assert.equal(r2.created, false)
    assert.equal(r1.messageId, r2.messageId)
    assert.equal(r1.outcome === "DRAFT_CREATED" && r2.outcome === "DRAFT_CREATED" && r1.draftId === r2.draftId, true)

    const messages = await db.acquisitionMessage.count({
      where: { companyId: companyA, externalMessageId: "msg-idem-1" },
    })
    const drafts = await db.worksiteImportDraft.count({
      where: { companyId: companyA, acquisitionMessage: { externalMessageId: "msg-idem-1" } },
    })
    const attachments = await db.acquisitionAttachment.count({
      where: { companyId: companyA, acquisitionMessage: { externalMessageId: "msg-idem-1" } },
    })
    assert.equal(messages, 1)
    assert.equal(drafts, 1)
    assert.equal(attachments, 2)
  })

  it("le même externalMessageId est autorisé pour deux entreprises différentes", async () => {
    const rA = await registerIncomingMessage(baseInput(companyA, "msg-shared-1", "mickaelloizelet@lauralu.fr"), db)
    const rB = await registerIncomingMessage(baseInput(companyB, "msg-shared-1", "mickaelloizelet@lauralu.fr"), db)
    assert.equal(rA.created, true)
    assert.equal(rB.created, true)
    assert.notEqual(rA.messageId, rB.messageId)
  })

  it("une entreprise ne peut pas accéder au brouillon d'une autre", async () => {
    const rA = await registerIncomingMessage(baseInput(companyA, "msg-tenant-1", "sabrinaaguera@lauralu.fr"), db)
    assert.equal(rA.outcome, "DRAFT_CREATED")
    const fromB = await getImportDraftForCompany(companyB, rA.draftId!, db)
    assert.equal(fromB, null)
    const fromA = await getImportDraftForCompany(companyA, rA.draftId!, db)
    assert.ok(fromA)
  })

  it("la base refuse un brouillon relié au message d'un autre tenant (FK composite)", async () => {
    const rA = await registerIncomingMessage(baseInput(companyA, "msg-fk-1", "user@gmail.com"), db)
    // Message de A (rejeté, sans brouillon) — tenter de créer un brouillon
    // portant companyId B relié à ce message de A : la FK composite doit refuser.
    await assert.rejects(
      db.worksiteImportDraft.create({
        data: {
          companyId: companyB,
          acquisitionMessageId: rA.messageId,
          status: "PENDING_EXTRACTION",
        },
      }),
      (e: unknown) =>
        typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2003"
    )
  })

  it("la base refuse une pièce jointe reliée au message d'un autre tenant (FK composite)", async () => {
    const rA = await registerIncomingMessage(baseInput(companyA, "msg-fk-2", "user@gmail.com"), db)
    await assert.rejects(
      db.acquisitionAttachment.create({
        data: {
          companyId: companyB,
          acquisitionMessageId: rA.messageId,
          attachmentKey: "ext:cross-tenant",
          filename: "intrusion.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
        },
      }),
      (e: unknown) =>
        typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2003"
    )
  })

  it("pièces jointes SANS externalAttachmentId : clés stables, aucun doublon possible", async () => {
    const input = {
      ...baseInput(companyA, "msg-noext-1", "carlenebourgine@lauralu.fr"),
      attachments: [
        { filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 100 },
        { filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 200 }, // même nom !
        { partId: "1.2", filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 300 },
      ],
    }
    const r1 = await registerIncomingMessage(input, db)
    const r2 = await registerIncomingMessage(input, db) // rappel idempotent
    assert.equal(r1.created, true)
    assert.equal(r2.created, false)

    const rows = await db.acquisitionAttachment.findMany({
      where: { companyId: companyA, acquisitionMessageId: r1.messageId },
      orderBy: { attachmentKey: "asc" },
    })
    assert.equal(rows.length, 3)
    assert.deepEqual(
      rows.map((a) => a.attachmentKey).sort(),
      ["ord:0", "ord:1", "part:1.2"]
    )

    // La contrainte d'unicité en base refuse un doublon de clé (P2002).
    await assert.rejects(
      db.acquisitionAttachment.create({
        data: {
          companyId: companyA,
          acquisitionMessageId: r1.messageId,
          attachmentKey: "ord:0",
          filename: "doublon.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
        },
      }),
      (e: unknown) =>
        typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002"
    )
  })

  it("rollback complet si la création du brouillon échoue", async () => {
    // Client saboté : worksiteImportDraft.create échoue DANS la transaction.
    const sabotaged = new Proxy(db, {
      get(target, prop) {
        if (prop === "$transaction") {
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(txTarget, txProp) {
                    if (txProp === "worksiteImportDraft") {
                      return {
                        create: async () => {
                          throw new Error("échec simulé de création du brouillon")
                        },
                      }
                    }
                    return (txTarget as Record<string | symbol, unknown>)[txProp]
                  },
                })
              )
            )
        }
        return (target as unknown as Record<string | symbol, unknown>)[prop]
      },
    }) as PrismaClient

    await assert.rejects(
      registerIncomingMessage(baseInput(companyA, "msg-rollback-1", "jeanlaurentcazala@lauralu.fr"), sabotaged),
      /échec simulé/
    )

    // Rien ne doit avoir été persisté : ni message, ni PJ, ni brouillon.
    const messages = await db.acquisitionMessage.count({
      where: { companyId: companyA, externalMessageId: "msg-rollback-1" },
    })
    assert.equal(messages, 0)
  })
})
