/**
 * PLAN-ACQ-MULTI-GMAIL-003 — concurrence PostgreSQL réelle legacy "" vs moderne.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent ou PostgreSQL injoignable.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import {
  registerIncomingMessage,
} from "@/lib/acquisition/acquisition.service"
import { buildAcquisitionMessageIdentityLockKeys } from "@/lib/acquisition/acquisition-message-identity-lock"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("PLAN-ACQ-MULTI-GMAIL-003 — PG identity lock", RUN, () => {
  const stamp = Date.now()
  let companyId = ""
  let db: PrismaClient
  let pgReachable = false
  let skipReason = ""

  before(async () => {
    db = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    try {
      await db.$queryRaw`SELECT 1`
      const company = await db.company.create({
        data: { name: `MultiGmail Race ${stamp}`, slug: `acq-mg-race-${stamp}` },
      })
      companyId = company.id
      await seedLauraluPartnerForCompany(db, companyId)
      pgReachable = true
    } catch (err) {
      skipReason = `PostgreSQL test injoignable: ${err instanceof Error ? err.message : String(err)}`
      await db.$disconnect().catch(() => {})
    }
  })

  after(async () => {
    if (!pgReachable || !companyId) return
    await db.company.deleteMany({ where: { id: companyId } })
    await db.$disconnect()
  })

  function requirePg(t: { skip: (msg?: string) => void }): boolean {
    if (pgReachable) return true
    t.skip(skipReason || "PostgreSQL test injoignable")
    return false
  }

  it("lock keys déterministes et distinctes par externalMessageId", () => {
    const a = buildAcquisitionMessageIdentityLockKeys({
      companyId: "co1",
      source: "GMAIL",
      externalMessageId: "ext-1",
    })
    const b = buildAcquisitionMessageIdentityLockKeys({
      companyId: "co1",
      source: "GMAIL",
      externalMessageId: "ext-1",
    })
    const c = buildAcquisitionMessageIdentityLockKeys({
      companyId: "co1",
      source: "GMAIL",
      externalMessageId: "ext-2",
    })
    assert.deepEqual(a, b)
    assert.notDeepEqual(a, c)
  })

  it("Promise.all legacy \"\" + moderne connectionId → 1 message / 1 draft", async (t) => {
    if (!requirePg(t)) return
    const ext = `race-lm-${stamp}`
    const base = {
      companyId,
      source: "GMAIL" as const,
      externalMessageId: ext,
      senderEmail: "carlenebourgine@lauralu.fr",
      subject: "Race legacy moderne",
      receivedAt: new Date("2026-07-01T12:00:00.000Z"),
      attachments: [
        {
          externalAttachmentId: "att-race",
          filename: "plan.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
        },
      ],
    }

    const [r1, r2] = await Promise.all([
      registerIncomingMessage({ ...base, sourceMailboxKey: "" }, db),
      registerIncomingMessage({ ...base, sourceMailboxKey: "conn-modern-a" }, db),
    ])

    assert.equal(r1.messageId, r2.messageId)
    const messages = await db.acquisitionMessage.findMany({
      where: { companyId, externalMessageId: ext },
      include: { draft: true },
    })
    assert.equal(messages.length, 1)
    const drafts = await db.worksiteImportDraft.count({
      where: { companyId, acquisitionMessage: { externalMessageId: ext } },
    })
    assert.equal(drafts, 1)
    assert.ok(
      (r1.outcome === "DRAFT_CREATED" && r1.draftId) ||
        (r2.outcome === "DRAFT_CREATED" && r2.draftId)
    )
  })

  it("Promise.all moderne A + moderne B → 2 messages distincts", async (t) => {
    if (!requirePg(t)) return
    const ext = `race-ab-${stamp}`
    const base = {
      companyId,
      source: "GMAIL" as const,
      externalMessageId: ext,
      senderEmail: "elodieagez@lauralu.fr",
      subject: "Race A B",
      receivedAt: new Date("2026-07-01T12:00:00.000Z"),
    }

    const [a, b] = await Promise.all([
      registerIncomingMessage({ ...base, sourceMailboxKey: "conn-a" }, db),
      registerIncomingMessage({ ...base, sourceMailboxKey: "conn-b" }, db),
    ])

    assert.notEqual(a.messageId, b.messageId)
    const messages = await db.acquisitionMessage.findMany({
      where: { companyId, externalMessageId: ext },
      orderBy: { sourceMailboxKey: "asc" },
    })
    assert.equal(messages.length, 2)
    assert.deepEqual(
      messages.map((m) => m.sourceMailboxKey).sort(),
      ["conn-a", "conn-b"]
    )
    const drafts = await db.worksiteImportDraft.count({
      where: { companyId, acquisitionMessage: { externalMessageId: ext } },
    })
    assert.equal(drafts, 2)
  })
})
