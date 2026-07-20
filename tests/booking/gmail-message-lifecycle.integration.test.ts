/**
 * Intégration PostgreSQL — lifecycle Booking + idempotence résultats.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { BookingGmailMessageLifecycle } from "@/lib/booking/gmail-message-lifecycle"
import { createOrGetBookingScanResult } from "@/lib/booking/booking-scan-result"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("booking gmail lifecycle — intégration PG", RUN, () => {
  let companyId = ""
  let companyB = ""
  let teamId = ""
  let adminId = ""
  const life = () => new BookingGmailMessageLifecycle(db)

  before(async () => {
    const suffix = `bk_${Date.now()}`
    const co = await db.company.create({
      data: { name: `Booking Test ${suffix}`, slug: `bk-${suffix}` },
    })
    companyId = co.id
    const co2 = await db.company.create({
      data: { name: `Booking Test B ${suffix}`, slug: `bk-b-${suffix}` },
    })
    companyB = co2.id
    const admin = await db.user.create({
      data: {
        email: `admin-${suffix}@test.local`,
        name: "Admin",
        password: "hash",
        role: "ADMIN",
        companyId,
      },
    })
    adminId = admin.id
    const employee = await db.employee.create({
      data: {
        userId: admin.id,
        companyId,
        firstName: "Makram",
        lastName: "Leader",
      },
    })
    const team = await db.team.create({
      data: {
        name: "Makram",
        companyId,
        active: true,
        leaderId: employee.id,
      },
    })
    teamId = team.id
  })

  after(async () => {
    if (!enabled) return
    await db.processedGmailMessage.deleteMany({
      where: { companyId: { in: [companyId, companyB] } },
    })
    await db.pendingAccommodation.deleteMany({
      where: { companyId: { in: [companyId, companyB] } },
    })
    await db.accommodation.deleteMany({
      where: { companyId: { in: [companyId, companyB] } },
    })
    await db.notification.deleteMany({
      where: { companyId: { in: [companyId, companyB] } },
    })
    await db.team.deleteMany({ where: { companyId: { in: [companyId, companyB] } } })
    await db.employee.deleteMany({ where: { companyId: { in: [companyId, companyB] } } })
    await db.user.deleteMany({ where: { companyId: { in: [companyId, companyB] } } })
    await db.company.deleteMany({ where: { id: { in: [companyId, companyB] } } })
    await db.$disconnect()
  })

  it("1. claim → pending → SUCCEEDED en TX", async () => {
    const msg = `m_pending_${Date.now()}`
    const claim = await life().claimForProcessing(companyId, msg)
    assert.equal(claim.action, "CLAIMED")

    const row = await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "snippet",
          parsed: {
            propertyName: "Appart Test",
            address: "12 rue de Paris",
            city: "Lyon",
            zipCode: "69001",
            startDate: "2026-08-01",
            endDate: "2026-08-05",
            doorCode: null,
            contactName: null,
            contactPhone: null,
            notes: null,
            teamName: null,
          },
          matchedTeamId: null,
          adminId,
        })
        return { resultType: r.resultType, resultEntityId: r.resultEntityId }
      },
      db
    )
    assert.equal(row.status, "SUCCEEDED")
    assert.equal(row.resultType, "PENDING_ACCOMMODATION")
    assert.ok(row.resultEntityId)

    const pending = await db.pendingAccommodation.findFirst({
      where: { companyId, gmailMessageId: msg },
    })
    assert.ok(pending)
  })

  it("2. claim → Accommodation → SUCCEEDED", async () => {
    const msg = `m_acc_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
    const row = await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "snippet",
          parsed: {
            propertyName: "Villa",
            address: "5 avenue Victor Hugo",
            city: "Paris",
            zipCode: "75016",
            startDate: "2026-09-01",
            endDate: "2026-09-10",
            doorCode: "1234",
            contactName: "Hote",
            contactPhone: null,
            notes: null,
            teamName: "Makram",
          },
          matchedTeamId: teamId,
          adminId,
        })
        return { resultType: r.resultType, resultEntityId: r.resultEntityId }
      },
      db
    )
    assert.equal(row.status, "SUCCEEDED")
    assert.equal(row.resultType, "ACCOMMODATION")
    const acc = await db.accommodation.findUnique({ where: { id: row.resultEntityId! } })
    assert.ok(acc)
    assert.equal(acc?.source, "gmail-scan")
  })

  it("9. rollback si callback jette — reste PROCESSING", async () => {
    const msg = `m_roll_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
    await assert.rejects(
      () =>
        life().markSucceededInTransaction(
          { companyId, messageId: msg },
          async () => {
            throw new Error("SIMULATED_CREATE_FAIL")
          },
          db
        ),
      /SIMULATED_CREATE_FAIL/
    )
    const row = await db.processedGmailMessage.findUnique({
      where: { companyId_messageId: { companyId, messageId: msg } },
    })
    assert.equal(row?.status, "PROCESSING")
  })

  it("13. rejeu createOrGet — pas de doublon pending", async () => {
    const msg = `m_idem_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
    await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "a",
          parsed: {
            propertyName: "X",
            address: "1 rue A",
            city: null,
            zipCode: null,
            startDate: "2026-10-01",
            endDate: "2026-10-02",
            doorCode: null,
            contactName: null,
            contactPhone: null,
            notes: null,
            teamName: null,
          },
          matchedTeamId: null,
          adminId,
        })
        return { resultType: r.resultType, resultEntityId: r.resultEntityId }
      },
      db
    )
    // Force PROCESSING again for replay of result helper only
    await db.processedGmailMessage.update({
      where: { companyId_messageId: { companyId, messageId: msg } },
      data: { status: "PROCESSING", succeededAt: null },
    })
    const second = await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "a",
          parsed: {
            propertyName: "X",
            address: "1 rue A",
            city: null,
            zipCode: null,
            startDate: "2026-10-01",
            endDate: "2026-10-02",
            doorCode: null,
            contactName: null,
            contactPhone: null,
            notes: null,
            teamName: null,
          },
          matchedTeamId: null,
          adminId,
        })
        assert.equal(r.createdNew, false)
        return { resultType: r.resultType, resultEntityId: r.resultEntityId }
      },
      db
    )
    const count = await db.pendingAccommodation.count({
      where: { companyId, gmailMessageId: msg },
    })
    assert.equal(count, 1)
    assert.equal(second.status, "SUCCEEDED")
  })

  it("14. isolation companyId", async () => {
    const msg = `shared_${Date.now()}`
    const a = await life().claimForProcessing(companyId, msg)
    const b = await life().claimForProcessing(companyB, msg)
    assert.equal(a.action, "CLAIMED")
    assert.equal(b.action, "CLAIMED")
  })
})
