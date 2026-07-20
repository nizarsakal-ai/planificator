/**
 * Intégration PostgreSQL — lifecycle Booking (PLAN-BOOKING-RELIABILITY-001-R1).
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import {
  BookingGmailMessageLifecycle,
  BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED,
} from "@/lib/booking/gmail-message-lifecycle"
import {
  createOrGetBookingScanResult,
  syntheticGmailBookingReference,
} from "@/lib/booking/booking-scan-result"

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
    process.env.BOOKING_GMAIL_MAX_ATTEMPTS = "3"
    process.env.BOOKING_GMAIL_PROCESSING_STALE_MS = String(15 * 60 * 1000)
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

  it("1. deux claims concurrents — un seul CLAIMED", async () => {
    const msg = `conc_${Date.now()}`
    const [a, b] = await Promise.all([
      life().claimForProcessing(companyId, msg),
      life().claimForProcessing(companyId, msg),
    ])
    const claimed = [a, b].filter((x) => x.action === "CLAIMED")
    const skipped = [a, b].filter((x) => x.action === "SKIP")
    assert.equal(claimed.length, 1)
    assert.equal(skipped.length, 1)
    const count = await db.processedGmailMessage.count({
      where: { companyId, messageId: msg },
    })
    assert.equal(count, 1)
  })

  it("2. retry concurrent RETRYABLE_FAILURE — un seul reclaim", async () => {
    const msg = `retry_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
    await life().markFailure({
      companyId,
      messageId: msg,
      error: new Error("timeout"),
      now: new Date(),
    })
    await db.processedGmailMessage.update({
      where: { companyId_messageId: { companyId, messageId: msg } },
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    })
    const [a, b] = await Promise.all([
      life().claimForProcessing(companyId, msg),
      life().claimForProcessing(companyId, msg),
    ])
    assert.equal([a, b].filter((x) => x.action === "CLAIMED").length, 1)
    assert.equal([a, b].filter((x) => x.action === "SKIP").length, 1)
  })

  it("3. stale concurrent PROCESSING — un seul reclaim", async () => {
    const msg = `stale_${Date.now()}`
    const stale = new Date(Date.now() - 20 * 60 * 1000)
    await db.processedGmailMessage.create({
      data: {
        companyId,
        messageId: msg,
        status: "PROCESSING",
        attemptCount: 1,
        firstAttemptAt: stale,
        lastAttemptAt: stale,
      },
    })
    const [a, b] = await Promise.all([
      life().claimForProcessing(companyId, msg),
      life().claimForProcessing(companyId, msg),
    ])
    assert.equal([a, b].filter((x) => x.action === "CLAIMED").length, 1)
    const row = await db.processedGmailMessage.findUniqueOrThrow({
      where: { companyId_messageId: { companyId, messageId: msg } },
    })
    assert.equal(row.attemptCount, 2)
  })

  it("4. TX résultat pending + SUCCEEDED", async () => {
    const msg = `m_pending_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
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
  })

  it("5. rollback si création résultat échoue", async () => {
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
    const pendings = await db.pendingAccommodation.count({
      where: { companyId, gmailMessageId: msg },
    })
    assert.equal(pendings, 0)
  })

  it("6. rollback statut final + markFailure n'écrase pas SUCCEEDED", async () => {
    const msg = `m_race_ok_${Date.now()}`
    await life().claimForProcessing(companyId, msg)

    // Dans la TX : créer un pending puis forcer SUCCEEDED avant updateMany → échec + rollback
    await assert.rejects(
      () =>
        life().markSucceededInTransaction(
          { companyId, messageId: msg },
          async (tx) => {
            const r = await createOrGetBookingScanResult(tx, {
              companyId,
              messageId: msg,
              snippet: "s",
              parsed: {
                propertyName: "P",
                address: "1 rue X",
                city: null,
                zipCode: null,
                startDate: "2026-11-01",
                endDate: "2026-11-02",
                doorCode: null,
                contactName: null,
                contactPhone: null,
                notes: null,
                teamName: null,
              },
              matchedTeamId: null,
              adminId,
            })
            await tx.processedGmailMessage.update({
              where: { companyId_messageId: { companyId, messageId: msg } },
              data: {
                status: "SUCCEEDED",
                succeededAt: new Date(),
                resultType: r.resultType,
                resultEntityId: r.resultEntityId,
              },
            })
            return { resultType: r.resultType, resultEntityId: r.resultEntityId }
          },
          db
        ),
      new RegExp(BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED)
    )
    const afterRollback = await db.processedGmailMessage.findUniqueOrThrow({
      where: { companyId_messageId: { companyId, messageId: msg } },
    })
    assert.equal(afterRollback.status, "PROCESSING")
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      0
    )

    // Succès réel puis markFailure concurrent simulé
    await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "s",
          parsed: {
            propertyName: "P",
            address: "1 rue X",
            city: null,
            zipCode: null,
            startDate: "2026-11-01",
            endDate: "2026-11-02",
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
    const failed = await life().markFailure({
      companyId,
      messageId: msg,
      error: new Error(BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED),
    })
    assert.equal(failed.status, "SUCCEEDED")
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      1
    )
  })

  it("7. rejeu après succès — claim SKIP + pas de doublon", async () => {
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
    const again = await life().claimForProcessing(companyId, msg)
    assert.equal(again.action, "SKIP")
    if (again.action === "SKIP") assert.equal(again.reason, "SUCCEEDED")
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      1
    )
  })

  it("8. même messageId deux tenants", async () => {
    const msg = `shared_${Date.now()}`
    const a = await life().claimForProcessing(companyId, msg)
    const b = await life().claimForProcessing(companyB, msg)
    assert.equal(a.action, "CLAIMED")
    assert.equal(b.action, "CLAIMED")
  })

  it("9. ligne historique SUCCEEDED non retraitée", async () => {
    const msg = `hist_${Date.now()}`
    await db.processedGmailMessage.create({
      data: {
        companyId,
        messageId: msg,
        status: "SUCCEEDED",
        attemptCount: 1,
        succeededAt: new Date("2026-01-01"),
        processedAt: new Date("2026-01-01"),
      },
    })
    const claim = await life().claimForProcessing(companyId, msg)
    assert.deepEqual(claim, { action: "SKIP", reason: "SUCCEEDED" })
  })

  it("10. dépassement max tentatives", async () => {
    const msg = `max_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
    for (let i = 0; i < 3; i++) {
      await life().markFailure({
        companyId,
        messageId: msg,
        error: new Error("timeout"),
        now: new Date(),
      })
      const row = await db.processedGmailMessage.findUniqueOrThrow({
        where: { companyId_messageId: { companyId, messageId: msg } },
      })
      if (row.status === "PERMANENTLY_IGNORED") {
        assert.equal(row.errorCode, "MAX_ATTEMPTS_EXCEEDED")
        return
      }
      assert.equal(row.status, "RETRYABLE_FAILURE")
      await db.processedGmailMessage.update({
        where: { id: row.id },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
      })
      const claim = await life().claimForProcessing(companyId, msg)
      assert.equal(claim.action, "CLAIMED")
    }
    const final = await life().markFailure({
      companyId,
      messageId: msg,
      error: new Error("timeout"),
    })
    assert.equal(final.status, "PERMANENTLY_IGNORED")
  })

  it("Accommodation synthétique bookingReference + source", async () => {
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
    assert.equal(row.resultType, "ACCOMMODATION")
    const acc = await db.accommodation.findUnique({ where: { id: row.resultEntityId! } })
    assert.equal(acc?.source, "gmail-scan")
    assert.equal(acc?.bookingReference, syntheticGmailBookingReference(companyId, msg))
  })
})
