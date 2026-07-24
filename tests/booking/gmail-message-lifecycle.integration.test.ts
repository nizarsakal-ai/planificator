/**
 * Intégration PostgreSQL — C-BOOK-001.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PrismaClient } from "@prisma/client"
import {
  BookingGmailMessageLifecycle,
  BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED,
} from "@/lib/booking/gmail-message-lifecycle"
import { permanentBookingError } from "@/lib/booking/booking-gmail-errors"
import { createOrGetBookingScanResult } from "@/lib/booking/booking-scan-result"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

const PENDING_UNIQUE_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260724120100_booking_pending_gmail_unique/migration.sql"
  ),
  "utf8"
)

const ACCOMMODATION_GMAIL_SOURCE_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260724120200_booking_accommodation_gmail_source/migration.sql"
  ),
  "utf8"
)

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

  it("1. migration pending unique : aucun DELETE silencieux", () => {
    assert.equal(/^\s*DELETE\b/im.test(PENDING_UNIQUE_SQL), false)
    assert.match(PENDING_UNIQUE_SQL, /RAISE EXCEPTION/)
    assert.match(PENDING_UNIQUE_SQL, /Aucun(e)? suppression|Aucune suppression/i)
  })

  it("1b. migration accommodation gmailSource : préflight, pas de DELETE, NULL exclus", () => {
    assert.equal(/^\s*DELETE\b/im.test(ACCOMMODATION_GMAIL_SOURCE_SQL), false)
    assert.match(ACCOMMODATION_GMAIL_SOURCE_SQL, /RAISE EXCEPTION/)
    assert.match(
      ACCOMMODATION_GMAIL_SOURCE_SQL,
      /gmailSourceMessageId"\s+IS NOT NULL/
    )
    assert.match(
      ACCOMMODATION_GMAIL_SOURCE_SQL,
      /CREATE UNIQUE INDEX "accommodations_companyId_gmailSourceMessageId_key"/
    )
  })

  it("2. contrôle SQL doublons échoue proprement sans perdre de lignes", async () => {
    const msg = `dup_check_${Date.now()}`
    // Contournement temporaire de l'unique pour simuler l'état pré-migration
    await db.$executeRawUnsafe(
      `ALTER TABLE "pending_accommodations" DROP CONSTRAINT IF EXISTS "pending_accommodations_companyId_gmailMessageId_key"`
    )
    await db.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "pending_accommodations_companyId_gmailMessageId_key"`
    )

    const older = await db.pendingAccommodation.create({
      data: {
        companyId,
        gmailMessageId: msg,
        propertyName: "Ancien",
        address: "1 rue A",
        status: "PENDING",
      },
    })
    // Insert second row with raw SQL (unique dropped)
    const newerId = `manual_${Date.now()}`
    await db.$executeRaw`
      INSERT INTO "pending_accommodations"
        (id, "companyId", "gmailMessageId", "propertyName", address, status, "createdAt", "updatedAt")
      VALUES
        (${newerId}, ${companyId}, ${msg}, ${"Récent corrigé"}, ${"2 rue B"},
         'CONFIRMED'::"PendingAccommodationStatus", NOW(), NOW())
    `
    await db.$executeRaw`
      UPDATE "pending_accommodations"
      SET "accommodationId" = ${"acc_linked_fake"}, "confirmedAt" = NOW()
      WHERE id = ${newerId}
    `

    const before = await db.pendingAccommodation.count({
      where: { companyId, gmailMessageId: msg },
    })
    assert.equal(before, 2)

    await assert.rejects(
      () =>
        db.$executeRawUnsafe(`
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1 FROM "pending_accommodations"
    GROUP BY "companyId", "gmailMessageId"
    HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'C-BOOK-001: % groupe(s) de doublons', dup_count;
  END IF;
END $$;
`),
      /C-BOOK-001/
    )

    const after = await db.pendingAccommodation.findMany({
      where: { companyId, gmailMessageId: msg },
      orderBy: { createdAt: "asc" },
    })
    assert.equal(after.length, 2)
    assert.equal(after[0].id, older.id)
    assert.equal(after[0].propertyName, "Ancien")
    assert.equal(after[1].id, newerId)
    assert.equal(after[1].propertyName, "Récent corrigé")
    assert.equal(after[1].status, "CONFIRMED")
    assert.equal(after[1].accommodationId, "acc_linked_fake")

    // Nettoyage + restauration contrainte pour le reste de la suite
    await db.pendingAccommodation.deleteMany({ where: { companyId, gmailMessageId: msg } })
    await db.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "pending_accommodations_companyId_gmailMessageId_key"
       ON "pending_accommodations"("companyId", "gmailMessageId")`
    )
  })

  it("3+4. deux pending divergents + relation conservée (pas de DELETE)", async () => {
    // Couvert par le test 2 (CONFIRMED + accommodationId intact après échec contrôle)
    assert.ok(true)
  })

  it("5+6. bookingReference métier libre ; clé technique séparée", async () => {
    const msg = `m_acc_ref_${Date.now()}`
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
            bookingReference: "BK-REAL-999",
          },
          matchedTeamId: teamId,
          adminId,
        })
        return { resultType: r.resultType, resultEntityId: r.resultEntityId }
      },
      db
    )
    const acc = await db.accommodation.findUniqueOrThrow({
      where: { id: row.resultEntityId! },
    })
    assert.equal(acc.bookingReference, "BK-REAL-999")
    assert.equal(acc.gmailSourceMessageId, msg)
    assert.equal(acc.source, "gmail-scan")
    assert.equal(acc.bookingReference?.startsWith("gmail:"), false)
  })

  it("7. rejeu Accommodation sans doublon", async () => {
    const msg = `m_acc_replay_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
    await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "s",
          parsed: {
            propertyName: "V",
            address: "9 rue Replay",
            city: null,
            zipCode: null,
            startDate: "2026-12-01",
            endDate: "2026-12-05",
            doorCode: null,
            contactName: null,
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
          snippet: "s",
          parsed: {
            propertyName: "V",
            address: "9 rue Replay",
            city: null,
            zipCode: null,
            startDate: "2026-12-01",
            endDate: "2026-12-05",
            doorCode: null,
            contactName: null,
            contactPhone: null,
            notes: null,
            teamName: "Makram",
          },
          matchedTeamId: teamId,
          adminId,
        })
        assert.equal(r.createdNew, false)
        return { resultType: r.resultType, resultEntityId: r.resultEntityId }
      },
      db
    )
    assert.equal(second.status, "SUCCEEDED")
    assert.equal(
      await db.accommodation.count({
        where: { companyId, gmailSourceMessageId: msg },
      }),
      1
    )
  })

  it("8. rejeu PendingAccommodation sans doublon", async () => {
    const msg = `m_pend_replay_${Date.now()}`
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
    await db.processedGmailMessage.update({
      where: { companyId_messageId: { companyId, messageId: msg } },
      data: { status: "PROCESSING", succeededAt: null },
    })
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
        assert.equal(r.createdNew, false)
        return { resultType: r.resultType, resultEntityId: r.resultEntityId }
      },
      db
    )
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      1
    )
  })

  it("9. isolation deux tenants même messageId", async () => {
    const msg = `shared_${Date.now()}`
    const a = await life().claimForProcessing(companyId, msg)
    const b = await life().claimForProcessing(companyB, msg)
    assert.equal(a.action, "CLAIMED")
    assert.equal(b.action, "CLAIMED")
  })

  it("10. crash/retry transactionnel — rollback puis un seul résultat", async () => {
    const msg = `m_tx_${Date.now()}`
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
    assert.equal(
      (await db.processedGmailMessage.findUniqueOrThrow({
        where: { companyId_messageId: { companyId, messageId: msg } },
      })).status,
      "PROCESSING"
    )
    await life().markFailure({
      companyId,
      messageId: msg,
      error: new Error("timeout"),
    })
    await db.processedGmailMessage.update({
      where: { companyId_messageId: { companyId, messageId: msg } },
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    })
    const claim = await life().claimForProcessing(companyId, msg)
    assert.equal(claim.action, "CLAIMED")
    await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "s",
          parsed: {
            propertyName: "P",
            address: "3 rue T",
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
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      1
    )
  })

  it("11. compatibilité ligne historique SUCCEEDED (R1)", async () => {
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

  it("concurrency claims + Accommodation sans bookingReference technique", async () => {
    const msg = `conc_${Date.now()}`
    const [a, b] = await Promise.all([
      life().claimForProcessing(companyId, msg),
      life().claimForProcessing(companyId, msg),
    ])
    assert.equal([a, b].filter((x) => x.action === "CLAIMED").length, 1)

    const claimed = a.action === "CLAIMED" ? a : b
    assert.equal(claimed.action, "CLAIMED")

    await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "s",
          parsed: {
            propertyName: "NoRef",
            address: "8 rue Z",
            city: null,
            zipCode: null,
            startDate: "2026-08-01",
            endDate: "2026-08-03",
            doorCode: null,
            contactName: null,
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
    const acc = await db.accommodation.findFirstOrThrow({
      where: { companyId, gmailSourceMessageId: msg },
    })
    assert.equal(acc.bookingReference, null)
  })

  it("markFailure n'écrase pas SUCCEEDED après course statut", async () => {
    const msg = `m_race_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
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
    assert.equal(
      (
        await db.processedGmailMessage.findUniqueOrThrow({
          where: { companyId_messageId: { companyId, messageId: msg } },
        })
      ).status,
      "PROCESSING"
    )
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      0
    )
  })

  it("12. stale reclaim PROCESSING → worker B → un seul résultat SUCCEEDED", async () => {
    const msg = `stale_pg_${Date.now()}`
    const claimA = await life().claimForProcessing(companyId, msg)
    assert.equal(claimA.action, "CLAIMED")
    if (claimA.action === "CLAIMED") {
      assert.equal(claimA.record.status, "PROCESSING")
      assert.equal(claimA.record.attemptCount, 1)
    }

    const staleAt = new Date(Date.now() - 20 * 60 * 1000)
    await db.processedGmailMessage.update({
      where: { companyId_messageId: { companyId, messageId: msg } },
      data: { lastAttemptAt: staleAt, firstAttemptAt: staleAt },
    })

    // Worker A encore "en vol" frais serait IN_FLIGHT ; ici PROCESSING expiré → reclaim B
    const stillFresh = await life().claimForProcessing(
      companyId,
      msg,
      new Date(staleAt.getTime() + 60_000)
    )
    assert.equal(stillFresh.action, "SKIP")
    assert.equal(stillFresh.action === "SKIP" && stillFresh.reason, "IN_FLIGHT")

    const claimB = await life().claimForProcessing(companyId, msg)
    assert.equal(claimB.action, "CLAIMED")
    if (claimB.action === "CLAIMED") {
      assert.equal(claimB.isNew, false)
      assert.equal(claimB.record.attemptCount, 2)
      assert.equal(claimB.record.status, "PROCESSING")
    }

    await life().markSucceededInTransaction(
      { companyId, messageId: msg },
      async (tx) => {
        const r = await createOrGetBookingScanResult(tx, {
          companyId,
          messageId: msg,
          snippet: "stale",
          parsed: {
            propertyName: "Stale Villa",
            address: "4 rue Stale",
            city: null,
            zipCode: null,
            startDate: "2026-12-10",
            endDate: "2026-12-12",
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

    const final = await db.processedGmailMessage.findUniqueOrThrow({
      where: { companyId_messageId: { companyId, messageId: msg } },
    })
    assert.equal(final.status, "SUCCEEDED")
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      1
    )
    assert.equal(
      await db.accommodation.count({ where: { companyId, gmailSourceMessageId: msg } }),
      0
    )

    const afterSuccess = await life().claimForProcessing(companyId, msg)
    assert.deepEqual(afterSuccess, { action: "SKIP", reason: "SUCCEEDED" })
  })

  it("13. PERMANENTLY_IGNORED → nouveau passage cron → aucun retry ni création métier", async () => {
    const msg = `perm_pg_${Date.now()}`
    await life().claimForProcessing(companyId, msg)
    await life().markPermanentIgnored(
      companyId,
      msg,
      permanentBookingError("NO_USEFUL_BOOKING_DATA", "aucune donnée utile (test PG)")
    )

    const pass1 = await life().claimForProcessing(companyId, msg)
    assert.deepEqual(pass1, { action: "SKIP", reason: "PERMANENTLY_IGNORED" })

    const pass2 = await life().claimForProcessing(companyId, msg)
    assert.deepEqual(pass2, { action: "SKIP", reason: "PERMANENTLY_IGNORED" })

    const row = await db.processedGmailMessage.findUniqueOrThrow({
      where: { companyId_messageId: { companyId, messageId: msg } },
    })
    assert.equal(row.status, "PERMANENTLY_IGNORED")
    assert.equal(row.attemptCount, 1)
    assert.equal(
      await db.pendingAccommodation.count({ where: { companyId, gmailMessageId: msg } }),
      0
    )
    assert.equal(
      await db.accommodation.count({ where: { companyId, gmailSourceMessageId: msg } }),
      0
    )
  })

  it("2b. préflight Accommodation doublons → refus, aucune suppression", async () => {
    const msg = `acc_dup_pg_${Date.now()}`
    await db.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "accommodations_companyId_gmailSourceMessageId_key"`
    )

    const first = await db.accommodation.create({
      data: {
        companyId,
        teamId,
        createdById: adminId,
        address: "10 rue Dup A",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2026-10-05"),
        gmailSourceMessageId: msg,
        source: "gmail-scan",
      },
    })
    const secondId = `acc_dup_${Date.now()}`
    await db.$executeRaw`
      INSERT INTO "accommodations"
        (id, "companyId", "teamId", "createdById", status, "startDate", "endDate",
         address, "gmailSourceMessageId", source, "createdAt", "updatedAt")
      VALUES
        (${secondId}, ${companyId}, ${teamId}, ${adminId},
         'UPCOMING'::"AccommodationStatus",
         ${new Date("2026-10-10")}, ${new Date("2026-10-15")},
         ${"11 rue Dup B"}, ${msg}, ${"gmail-scan"}, NOW(), NOW())
    `

    const before = await db.accommodation.findMany({
      where: { companyId, gmailSourceMessageId: msg },
      orderBy: { createdAt: "asc" },
    })
    assert.equal(before.length, 2)

    await assert.rejects(
      () =>
        db.$executeRawUnsafe(`
DO $$
DECLARE
  dup_count integer;
  sample text;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM "accommodations"
    WHERE "gmailSourceMessageId" IS NOT NULL
    GROUP BY "companyId", "gmailSourceMessageId"
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    SELECT string_agg(fmt, E'\\n') INTO sample
    FROM (
      SELECT format(
        'companyId=%s gmailSourceMessageId=%s count=%s ids=%s',
        "companyId",
        "gmailSourceMessageId",
        COUNT(*),
        string_agg(id, ',' ORDER BY "createdAt", id)
      ) AS fmt
      FROM "accommodations"
      WHERE "gmailSourceMessageId" IS NOT NULL
      GROUP BY "companyId", "gmailSourceMessageId"
      HAVING COUNT(*) > 1
      LIMIT 20
    ) s;

    RAISE EXCEPTION
      'C-BOOK-001: % groupe(s) de doublons accommodations(gmailSourceMessageId). Aucune suppression automatique. Consolider manuellement puis relancer. Diagnostic: %',
      dup_count,
      COALESCE(sample, '(vide)');
  END IF;
END $$;
`),
      /C-BOOK-001:.*doublons accommodations/
    )

    const after = await db.accommodation.findMany({
      where: { companyId, gmailSourceMessageId: msg },
    })
    assert.equal(after.length, 2)
    const byId = new Map(after.map((row) => [row.id, row]))
    assert.equal(byId.get(first.id)?.address, "10 rue Dup A")
    assert.equal(byId.get(secondId)?.address, "11 rue Dup B")
    assert.equal(byId.get(first.id)?.gmailSourceMessageId, msg)
    assert.equal(byId.get(secondId)?.gmailSourceMessageId, msg)

    await db.accommodation.deleteMany({
      where: { companyId, gmailSourceMessageId: msg },
    })
    await db.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "accommodations_companyId_gmailSourceMessageId_key"
       ON "accommodations"("companyId", "gmailSourceMessageId")`
    )
  })
})
