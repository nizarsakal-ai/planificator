/**
 * Expéditeur ajouté au registre APRÈS le rejet de ses e-mails (cas ATS / ats67.com,
 * 16/11/2026) : le message rejeté doit être promu en consultation au re-scan,
 * sans doublon. Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionPartnerAdminService } from "@/lib/acquisition/admin/partner-admin.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const RUN = { skip: TEST_URL ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("Sources de consultations — promotion d'un rejet devenu éligible (PG)", RUN, () => {
  const stamp = Date.now()
  let db: PrismaClient
  let companyId = ""

  before(async () => {
    db = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    const company = await db.company.create({ data: { name: `Sources ${stamp}`, slug: `acq-sources-${stamp}` } })
    companyId = company.id
    await seedLauraluPartnerForCompany(db, companyId)
  })

  after(async () => {
    if (companyId) await db.company.deleteMany({ where: { id: companyId } })
    await db.$disconnect()
  })

  const input = () => ({
    companyId,
    source: "GMAIL" as const,
    externalMessageId: `ats-${stamp}`,
    sourceMailboxKey: "conn-galya",
    threadId: "t-ats",
    senderEmail: "Eric LOUX <eloux@ats67.com>",
    subject: "RE: Adresse de livraison express – Chapiteau à Paris",
    receivedAt: new Date("2026-11-16T14:42:00Z"),
    attachments: [{ externalAttachmentId: "att-1", filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 1200 }],
  })

  it("rejeté tant que le domaine est inconnu, promu une seule fois après ajout", async () => {
    const first = await registerIncomingMessage(input(), db)
    assert.equal(first.outcome, "REJECTED")
    assert.equal(first.created, true)

    // Re-scan sans changement : reste rejeté, aucun brouillon.
    const again = await registerIncomingMessage(input(), db)
    assert.equal(again.outcome, "REJECTED")
    assert.equal(again.created, false)

    const admin = new AcquisitionPartnerAdminService({ db: db as never })
    const partner = await admin.createPartner({ companyId, name: "ATS", code: "ats" })
    await admin.addDomain({ companyId, partnerId: partner.id, domain: "ats67.com" })

    // Re-scan après ajout : promotion (brouillon + PJ), puis idempotence stricte.
    const [a, b] = await Promise.all([registerIncomingMessage(input(), db), registerIncomingMessage(input(), db)])
    const promoted = [a, b].filter((r) => r.outcome === "DRAFT_CREATED")
    assert.equal(promoted.length, 2, "les deux appels voient le brouillon")
    assert.equal([a, b].filter((r) => r.created).length, 1, "une seule promotion effective")

    const msg = await db.acquisitionMessage.findFirstOrThrow({
      where: { companyId, externalMessageId: `ats-${stamp}` },
      include: { draft: true, attachments: true },
    })
    assert.equal(msg.status, "DRAFT_CREATED")
    assert.equal(msg.resolvedPartnerId, partner.id)
    assert.equal(msg.lastErrorCode, null)
    assert.equal(msg.draft?.status, "PENDING_EXTRACTION")
    assert.equal(msg.attachments.length, 1)
    assert.equal(await db.worksiteImportDraft.count({ where: { companyId, acquisitionMessageId: msg.id } }), 1)

    const later = await registerIncomingMessage(input(), db)
    assert.equal(later.outcome, "DRAFT_CREATED")
    assert.equal(later.created, false)
  })

  it("un expéditeur hors registre reste rejeté (jamais promu)", async () => {
    const r1 = await registerIncomingMessage({ ...input(), externalMessageId: `spam-${stamp}`, senderEmail: "promo@spam.example" }, db)
    const r2 = await registerIncomingMessage({ ...input(), externalMessageId: `spam-${stamp}`, senderEmail: "promo@spam.example" }, db)
    assert.equal(r1.outcome, "REJECTED")
    assert.equal(r2.outcome, "REJECTED")
    assert.equal(r2.created, false)
  })
})
