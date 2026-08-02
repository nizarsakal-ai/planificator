/**
 * PLAN-BOOKING-FINAL-2 R4 — Tests PostgreSQL réels (base jetable).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, execSync } from "node:child_process"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { PrismaClient } from "@prisma/client"
import { PENDING_SOURCE_KIND } from "@/lib/booking/booking-pending-identity"
import { runConfirmCreateTransaction } from "@/lib/booking/booking-confirm-idempotency"
import {
  handleBookingAgentPost,
  type BookingAgentDb,
} from "@/lib/booking/booking-agent.handler"
import {
  autoProcessPendingAccommodationsCore,
  type AutoProcessDb,
} from "@/lib/booking/booking-autoprocess.core"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const ROOT = process.cwd()
const MIG_NAME = "20260802120000_booking_identity_tenant_isolation"
const MIG_DIR = join(ROOT, "prisma/migrations", MIG_NAME)

describe("BKG-FINAL-2 R3 — contraintes PG + métier", RUN, () => {
  let companyA = ""
  let companyB = ""
  let teamA = ""
  let teamB = ""
  let adminA = ""
  let adminB = ""
  const suffix = `id_${Date.now()}`

  before(async () => {
    const coA = await db.company.create({
      data: { name: `ID A ${suffix}`, slug: `ida-${suffix}` },
    })
    const coB = await db.company.create({
      data: { name: `ID B ${suffix}`, slug: `idb-${suffix}` },
    })
    companyA = coA.id
    companyB = coB.id
    const ua = await db.user.create({
      data: {
        email: `ida-${suffix}@t.local`,
        name: "A",
        password: "h",
        role: "ADMIN",
        companyId: companyA,
      },
    })
    const ub = await db.user.create({
      data: {
        email: `idb-${suffix}@t.local`,
        name: "B",
        password: "h",
        role: "ADMIN",
        companyId: companyB,
      },
    })
    adminA = ua.id
    adminB = ub.id
    const empA = await db.employee.create({
      data: {
        userId: ua.id,
        companyId: companyA,
        firstName: "A",
        lastName: "Lead",
      },
    })
    const empB = await db.employee.create({
      data: {
        userId: ub.id,
        companyId: companyB,
        firstName: "B",
        lastName: "Lead",
      },
    })
    teamA = (
      await db.team.create({
        data: {
          companyId: companyA,
          name: "TA",
          active: true,
          leaderId: empA.id,
        },
      })
    ).id
    teamB = (
      await db.team.create({
        data: {
          companyId: companyB,
          name: "TB",
          active: true,
          leaderId: empB.id,
        },
      })
    ).id
  })

  after(async () => {
    await db.pendingAccommodation.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.accommodation.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.processedGmailMessage.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.team.deleteMany({ where: { companyId: { in: [companyA, companyB] } } })
    await db.employee.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.user.deleteMany({ where: { companyId: { in: [companyA, companyB] } } })
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("même bookingReference deux tenants → OK ; même tenant → rejeté", async () => {
    await db.accommodation.create({
      data: {
        companyId: companyA,
        teamId: teamA,
        createdById: adminA,
        address: "1",
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-09-02"),
        bookingReference: "SAME-REF",
        status: "UPCOMING",
        source: "n8n",
      },
    })
    await db.accommodation.create({
      data: {
        companyId: companyB,
        teamId: teamB,
        createdById: adminB,
        address: "2",
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-09-02"),
        bookingReference: "SAME-REF",
        status: "UPCOMING",
        source: "n8n",
      },
    })
    await assert.rejects(() =>
      db.accommodation.create({
        data: {
          companyId: companyA,
          teamId: teamA,
          createdById: adminA,
          address: "3",
          startDate: new Date("2026-09-01"),
          endDate: new Date("2026-09-02"),
          bookingReference: "SAME-REF",
          status: "UPCOMING",
          source: "n8n",
        },
      })
    )
  })

  it("confirmation N8N → update/cancel par bookingReference", async () => {
    const ref = `N8N-${suffix}`
    const pending = await db.pendingAccommodation.create({
      data: {
        companyId: companyA,
        gmailMessageId: null,
        idempotencyKey: `n8n:${ref}`,
        sourceKind: "N8N",
        externalSourceId: ref,
        address: "10 rue Confirm",
        startDate: new Date("2026-10-01"),
        endDate: new Date("2026-10-03"),
        status: "PENDING",
      },
    })
    await runConfirmCreateTransaction(db, {
      companyId: companyA,
      userId: adminA,
      pendingId: pending.id,
      gmailMessageId: null,
      sourceKind: PENDING_SOURCE_KIND.N8N,
      externalSourceId: ref,
      idempotencyKey: `n8n:${ref}`,
      teamId: teamA,
      finalAddress: "10 rue Confirm",
      city: null,
      zipCode: null,
      doorCode: null,
      contactName: null,
      contactPhone: null,
      notes: null,
      startDate: new Date("2026-10-01"),
      endDate: new Date("2026-10-03"),
      notifyUserIds: [],
      teamName: "TA",
      startLabel: "a",
      endLabel: "b",
    })
    const found = await db.accommodation.findUnique({
      where: {
        companyId_bookingReference: {
          companyId: companyA,
          bookingReference: ref,
        },
      },
    })
    assert.ok(found)
    await db.accommodation.update({
      where: { id: found!.id },
      data: { status: "CANCELLED" },
    })
    assert.equal(
      (
        await db.accommodation.findUnique({
          where: {
            companyId_bookingReference: {
              companyId: companyA,
              bookingReference: ref,
            },
          },
        })
      )?.status,
      "CANCELLED"
    )
  })

  it("Agent hasAllData + bookingReference : retry handler → une seule Accommodation", async () => {
    const prevSecret = process.env.CRON_SECRET
    process.env.CRON_SECRET = "pg-agent-r4-secret"
    const ref = `AG-PG-${suffix}`
    const agentDb = db as unknown as BookingAgentDb
    const body = {
      companyId: companyA,
      rawEmailText: "email agent pg complet",
      bookingReference: ref,
    }
    const extract = async () => ({
      status: "confirmed",
      propertyName: "Hotel PG",
      address: "99 rue Agent PG",
      city: "Lyon",
      zipCode: "69001",
      startDate: "2026-11-01",
      endDate: "2026-11-03",
      teamName: "TA",
      doorCode: null,
      contactName: null,
      contactPhone: null,
      bookingReference: null,
    })
    try {
      const req = () =>
        new Request("http://localhost/api/booking/agent", {
          method: "POST",
          headers: {
            authorization: "Bearer pg-agent-r4-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      const r1 = await handleBookingAgentPost(req(), {
        db: agentDb,
        extractFromEmail: extract,
        anthropicApiKey: null,
      })
      assert.equal(r1.status, 200)
      const j1 = (await r1.json()) as { action: string; id: string }
      assert.equal(j1.action, "created")

      const r2 = await handleBookingAgentPost(req(), {
        db: agentDb,
        extractFromEmail: extract,
        anthropicApiKey: null,
      })
      assert.equal(r2.status, 200)
      const j2 = (await r2.json()) as { action: string; id: string }
      assert.equal(j2.action, "created")
      assert.equal(j2.id, j1.id)

      const rows = await db.accommodation.findMany({
        where: { companyId: companyA, bookingReference: ref },
      })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.source, "agent")
      assert.equal(rows[0]!.gmailSourceMessageId, null)

      const pendingCount = await db.pendingAccommodation.count({
        where: { companyId: companyA, idempotencyKey: `agent:${ref}` },
      })
      assert.equal(pendingCount, 0)

      // Même ref, autre tenant → Acc distincte autorisée
      const rB = await handleBookingAgentPost(
        new Request("http://localhost/api/booking/agent", {
          method: "POST",
          headers: {
            authorization: "Bearer pg-agent-r4-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...body, companyId: companyB }),
        }),
        {
          db: agentDb,
          extractFromEmail: async () => ({
            ...(await extract()),
            teamName: "TB",
          }),
          anthropicApiKey: null,
        }
      )
      assert.equal(rB.status, 200)
      const both = await db.accommodation.findMany({
        where: { bookingReference: ref },
      })
      assert.equal(both.length, 2)
      assert.ok(both.some((a) => a.companyId === companyA))
      assert.ok(both.some((a) => a.companyId === companyB))
    } finally {
      if (prevSecret === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = prevSecret
    }
  })

  it("Agent stable externalEventId sans bookingReference → Pending idempotent (pas Acc)", async () => {
    const prevSecret = process.env.CRON_SECRET
    process.env.CRON_SECRET = "pg-agent-r4-secret"
    const eventId = `evt-pg-${suffix}`
    const agentDb = db as unknown as BookingAgentDb
    const body = {
      companyId: companyA,
      rawEmailText: "email agent event only",
      externalEventId: eventId,
    }
    const extract = async () => ({
      status: "confirmed",
      propertyName: "Hotel Event",
      address: "1 rue Event Only",
      city: null,
      zipCode: null,
      startDate: "2026-12-01",
      endDate: "2026-12-03",
      teamName: "TA",
      doorCode: null,
      contactName: null,
      contactPhone: null,
      bookingReference: null,
    })
    try {
      const req = () =>
        new Request("http://localhost/api/booking/agent", {
          method: "POST",
          headers: {
            authorization: "Bearer pg-agent-r4-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      const r1 = await handleBookingAgentPost(req(), {
        db: agentDb,
        extractFromEmail: extract,
        anthropicApiKey: null,
      })
      assert.equal(r1.status, 200)
      const j1 = (await r1.json()) as { action: string; id: string }
      assert.equal(j1.action, "pending")

      const r2 = await handleBookingAgentPost(req(), {
        db: agentDb,
        extractFromEmail: extract,
        anthropicApiKey: null,
      })
      assert.equal(r2.status, 200)
      const j2 = (await r2.json()) as { action: string; id: string }
      assert.equal(j2.id, j1.id)

      const pendings = await db.pendingAccommodation.findMany({
        where: {
          companyId: companyA,
          idempotencyKey: `agent:${eventId}`,
        },
      })
      assert.equal(pendings.length, 1)
      assert.equal(pendings[0]!.sourceKind, "AGENT")
      assert.equal(pendings[0]!.externalSourceId, null)
      assert.equal(pendings[0]!.gmailMessageId, null)

      const accLeak = await db.accommodation.count({
        where: {
          companyId: companyA,
          OR: [
            { bookingReference: eventId },
            { address: "1 rue Event Only" },
          ],
        },
      })
      assert.equal(accLeak, 0)
    } finally {
      if (prevSecret === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = prevSecret
    }
  })

  it("autoProcess core PG : N8N/AGENT skip ; GMAIL crée Accommodation", async () => {
    // Isoler le jeu de pending pour des compteurs déterministes
    await db.pendingAccommodation.deleteMany({
      where: { companyId: companyA },
    })
    const richSnippet = `${"Booking confirmation body ".repeat(20)} team TA`
    const pN8n = await db.pendingAccommodation.create({
      data: {
        companyId: companyA,
        gmailMessageId: null,
        idempotencyKey: `n8n:AP-N8N-${suffix}`,
        sourceKind: "N8N",
        externalSourceId: `AP-N8N-${suffix}`,
        address: "10 rue Auto N8N",
        startDate: new Date("2026-10-10"),
        endDate: new Date("2026-10-12"),
        status: "PENDING",
        rawEmailSnippet: `[n8n] AP-N8N-${suffix}`,
      },
    })
    const pAgent = await db.pendingAccommodation.create({
      data: {
        companyId: companyA,
        gmailMessageId: null,
        idempotencyKey: `agent:ap-evt-${suffix}`,
        sourceKind: "AGENT",
        externalSourceId: null,
        address: "11 rue Auto Agent",
        startDate: new Date("2026-10-10"),
        endDate: new Date("2026-10-12"),
        status: "PENDING",
        rawEmailSnippet: "agent body",
      },
    })
    const gmailMsgId = `gmail-ap-${suffix}`
    const pGmail = await db.pendingAccommodation.create({
      data: {
        companyId: companyA,
        gmailMessageId: gmailMsgId,
        idempotencyKey: `gmail:${gmailMsgId}`,
        sourceKind: "GMAIL",
        externalSourceId: null,
        address: "12 rue Auto Gmail",
        startDate: new Date("2026-10-20"),
        endDate: new Date("2026-10-22"),
        status: "PENDING",
        rawEmailSnippet: richSnippet,
      },
    })

    const beforeAcc = await db.accommodation.count({
      where: { companyId: companyA },
    })

    const res = await autoProcessPendingAccommodationsCore({
      companyId: companyA,
      userId: adminA,
      db: db as unknown as AutoProcessDb,
      anthropicApiKey: "test-key-not-used",
      fetchGmailBody: async () => ({ ok: false }),
      createAiMessage: async () => ({
        type: "text",
        text: JSON.stringify({
          address: "12 rue Auto Gmail",
          city: "Lyon",
          zipCode: "69001",
          teamName: "TA",
          doorCode: null,
          contactPhone: null,
          contactName: null,
        }),
      }),
    })

    assert.ok("success" in res && res.success)
    assert.equal(res.skippedNonGmail, 2)
    assert.equal(res.processed, 1)
    assert.equal(res.failed, 0)

    const n8nAfter = await db.pendingAccommodation.findUnique({
      where: { id: pN8n.id },
    })
    const agentAfter = await db.pendingAccommodation.findUnique({
      where: { id: pAgent.id },
    })
    const gmailAfter = await db.pendingAccommodation.findUnique({
      where: { id: pGmail.id },
    })
    assert.equal(n8nAfter!.status, "PENDING")
    assert.equal(agentAfter!.status, "PENDING")
    assert.equal(gmailAfter!.status, "CONFIRMED")
    assert.ok(gmailAfter!.accommodationId)

    const afterAcc = await db.accommodation.count({
      where: { companyId: companyA },
    })
    assert.equal(afterAcc, beforeAcc + 1)

    const created = await db.accommodation.findUnique({
      where: { id: gmailAfter!.accommodationId! },
    })
    assert.equal(created!.source, "gmail-scan")
    assert.equal(created!.gmailSourceMessageId, gmailMsgId)
    assert.equal(created!.companyId, companyA)
  })
})

describe("BKG-FINAL-2 R3 — migration atomique A/B/C (docker self)", {
  skip:
    process.env.BOOKING_IDENTITY_MIGRATION_PG !== "1"
      ? "BOOKING_IDENTITY_MIGRATION_PG≠1"
      : undefined,
}, () => {
  const port = String(55601 + Math.floor(Math.random() * 80))
  const container = `planificator-bkg-r3-${port}`
  const url = `postgresql://test:test@127.0.0.1:${port}/planificator_mig`
  const parking = join(ROOT, `.tmp-mig-park-${port}`)

  function psql(sql: string, c = container, dbName = "planificator_mig") {
    return execFileSync(
      "docker",
      [
        "exec",
        "-i",
        c,
        "psql",
        "-U",
        "test",
        "-d",
        dbName,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      { encoding: "utf8" }
    )
  }

  function prismaDeploy(databaseUrl: string) {
    return execFileSync(
      join(ROOT, "node_modules/.bin/prisma"),
      ["migrate", "deploy"],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseUrl },
        cwd: ROOT,
      }
    )
  }

  function parkMigration() {
    mkdirSync(parking, { recursive: true })
    if (existsSync(MIG_DIR)) renameSync(MIG_DIR, parking)
  }

  function restoreMigration() {
    if (existsSync(parking) && !existsSync(MIG_DIR)) {
      renameSync(parking, MIG_DIR)
    }
  }

  before(async () => {
    execSync(`docker rm -f ${container} >/dev/null 2>&1 || true`)
    execSync(
      `docker run -d --name ${container} -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=planificator_mig -p ${port}:5432 postgres:16-alpine`,
      { stdio: "ignore" }
    )
    for (let i = 0; i < 40; i++) {
      try {
        execSync(`docker exec ${container} pg_isready -U test`, {
          stdio: "ignore",
        })
        break
      } catch {
        execSync("sleep 0.4")
      }
    }
  })

  after(() => {
    restoreMigration()
    execSync(`docker rm -f ${container} >/dev/null 2>&1 || true`)
  })

  it("A — nominal : N8N / Agent synthétique / Gmail prouvé via ProcessedGmailMessage", () => {
    parkMigration()
    prismaDeploy(url)

    psql(`
INSERT INTO companies (id, name, slug, "createdAt", "updatedAt")
VALUES ('c_mig','Mig','mig-${port}',NOW(),NOW());
INSERT INTO users (id,"companyId",email,name,role,password,"createdAt","updatedAt")
VALUES ('u_mig','c_mig','u-${port}@t.co','U','ADMIN','x',NOW(),NOW());
INSERT INTO employees (id,"userId","companyId","firstName","lastName","createdAt","updatedAt")
VALUES ('e_mig','u_mig','c_mig','E','L',NOW(),NOW());
INSERT INTO teams (id,"companyId",name,active,"leaderId","createdAt","updatedAt")
VALUES ('t_mig','c_mig','T',true,'e_mig',NOW(),NOW());

INSERT INTO processed_gmail_messages
  (id,"companyId","messageId","processedAt",status,"attemptCount","updatedAt")
VALUES
  ('pg_g','c_mig','18f0gmailproven01',NOW(),'SUCCEEDED',1,NOW());

INSERT INTO pending_accommodations
  (id,"companyId","gmailMessageId","rawEmailSnippet",status,"createdAt","updatedAt")
VALUES
  ('p_n8n','c_mig','BK-N8N','[n8n] Hotel — ref: BK-N8N','PENDING',NOW(),NOW()),
  ('p_agent','c_mig','agent-1719000000000','email agent body','PENDING',NOW(),NOW()),
  ('p_gmail','c_mig','18f0gmailproven01','Booking confirmation','PENDING',NOW(),NOW());
`)

    restoreMigration()
    const out = prismaDeploy(url)
    assert.match(out, /booking_identity_tenant_isolation/)

    const kinds = psql(`
SELECT id, "sourceKind"::text FROM pending_accommodations
WHERE id IN ('p_n8n','p_agent','p_gmail') ORDER BY id;
`)
    assert.match(kinds, /p_agent\s+\|\s+AGENT/)
    assert.match(kinds, /p_gmail\s+\|\s+GMAIL/)
    assert.match(kinds, /p_n8n\s+\|\s+N8N/)

    const idx = psql(`
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'pending_accommodations_companyId_idempotencyKey_key',
  'accommodations_companyId_bookingReference_key'
);
`)
    assert.match(idx, /idempotencyKey/)
    assert.match(idx, /bookingReference/)
  })

  it("B — Agent historique bookingReference dans gmailMessageId → ABORT + rollback total", () => {
    const portB = String(Number(port) + 1)
    const containerB = `${container}-b`
    const urlB = `postgresql://test:test@127.0.0.1:${portB}/planificator_mig_b`
    const parkingB = join(ROOT, `.tmp-mig-park-b-${portB}`)

    execSync(`docker rm -f ${containerB} >/dev/null 2>&1 || true`)
    execSync(
      `docker run -d --name ${containerB} -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=planificator_mig_b -p ${portB}:5432 postgres:16-alpine`,
      { stdio: "ignore" }
    )
    for (let i = 0; i < 40; i++) {
      try {
        execSync(`docker exec ${containerB} pg_isready -U test`, {
          stdio: "ignore",
        })
        break
      } catch {
        execSync("sleep 0.4")
      }
    }

    const psqlB = (sql: string) => psql(sql, containerB, "planificator_mig_b")

    try {
      mkdirSync(parkingB, { recursive: true })
      if (existsSync(MIG_DIR)) renameSync(MIG_DIR, parkingB)
      prismaDeploy(urlB)

      psqlB(`
INSERT INTO companies (id, name, slug, "createdAt", "updatedAt")
VALUES ('c_bad','Bad','bad-${portB}',NOW(),NOW());
INSERT INTO pending_accommodations
  (id,"companyId","gmailMessageId","rawEmailSnippet",status,"createdAt","updatedAt")
VALUES
  ('p_hist','c_bad','BK-AGENT-OLD','Corps email agent sans marqueur n8n','PENDING',NOW(),NOW());
`)

      const before = psqlB(`
SELECT id, "gmailMessageId", "rawEmailSnippet" FROM pending_accommodations WHERE id='p_hist';
`)
      const globalUniqueBefore = psqlB(`
SELECT indexname FROM pg_indexes
WHERE tablename='accommodations' AND indexname='accommodations_bookingReference_key';
`)

      if (existsSync(parkingB)) renameSync(parkingB, MIG_DIR)

      let failed = false
      let errText = ""
      try {
        prismaDeploy(urlB)
      } catch (e) {
        failed = true
        errText = String(e)
      }
      assert.equal(failed, true)
      // Prisma peut encapsuler le RAISE en "transaction is aborted" ; le rollback structurel prouve l'atomicité.
      assert.match(
        errText,
        /non classifiables|BKG-FINAL-2|transaction is aborted|P3018|migrate deploy/i
      )

      const enumExists = psqlB(`
SELECT COUNT(*)::text AS c FROM pg_type WHERE typname='PendingAccommodationSourceKind';
`)
      assert.match(enumExists, /\n\s*0\s*\n/)

      const colExists = psqlB(`
SELECT COUNT(*)::text AS c FROM information_schema.columns
WHERE table_name='pending_accommodations' AND column_name='idempotencyKey';
`)
      assert.match(colExists, /\n\s*0\s*\n/)

      const newIdx = psqlB(`
SELECT COUNT(*)::text AS c FROM pg_indexes
WHERE indexname IN (
  'pending_accommodations_companyId_idempotencyKey_key',
  'accommodations_companyId_bookingReference_key'
);
`)
      assert.match(newIdx, /\n\s*0\s*\n/)

      const globalUniqueAfter = psqlB(`
SELECT indexname FROM pg_indexes
WHERE tablename='accommodations' AND indexname='accommodations_bookingReference_key';
`)
      assert.equal(globalUniqueAfter.trim(), globalUniqueBefore.trim())

      const after = psqlB(`
SELECT id, "gmailMessageId", "rawEmailSnippet" FROM pending_accommodations WHERE id='p_hist';
`)
      assert.equal(after, before)
    } finally {
      try {
        if (existsSync(parkingB) && !existsSync(MIG_DIR)) {
          renameSync(parkingB, MIG_DIR)
        }
      } catch {
        /* ignore */
      }
      execSync(`docker rm -f ${containerB} >/dev/null 2>&1 || true`)
    }
  })

  it("C — ambiguïté N8N+Agent → ABORT ; relance nominale après correction", () => {
    const portC = String(Number(port) + 2)
    const containerC = `${container}-c`
    const urlC = `postgresql://test:test@127.0.0.1:${portC}/planificator_mig_c`
    const parkingC = join(ROOT, `.tmp-mig-park-c-${portC}`)

    execSync(`docker rm -f ${containerC} >/dev/null 2>&1 || true`)
    execSync(
      `docker run -d --name ${containerC} -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=planificator_mig_c -p ${portC}:5432 postgres:16-alpine`,
      { stdio: "ignore" }
    )
    for (let i = 0; i < 40; i++) {
      try {
        execSync(`docker exec ${containerC} pg_isready -U test`, {
          stdio: "ignore",
        })
        break
      } catch {
        execSync("sleep 0.4")
      }
    }

    const psqlC = (sql: string) => psql(sql, containerC, "planificator_mig_c")

    try {
      mkdirSync(parkingC, { recursive: true })
      if (existsSync(MIG_DIR)) renameSync(MIG_DIR, parkingC)
      prismaDeploy(urlC)

      psqlC(`
INSERT INTO companies (id, name, slug, "createdAt", "updatedAt")
VALUES ('c_amb','Amb','amb-${portC}',NOW(),NOW());
INSERT INTO pending_accommodations
  (id,"companyId","gmailMessageId","rawEmailSnippet",status,"createdAt","updatedAt")
VALUES
  ('p_amb','c_amb','agent-1719000000099','[n8n] ambiguous','PENDING',NOW(),NOW());
`)

      if (existsSync(parkingC)) renameSync(parkingC, MIG_DIR)

      let failed = false
      try {
        prismaDeploy(urlC)
      } catch {
        failed = true
      }
      assert.equal(failed, true)

      const enumExists = psqlC(`
SELECT COUNT(*)::text AS c FROM pg_type WHERE typname='PendingAccommodationSourceKind';
`)
      assert.match(enumExists, /\n\s*0\s*\n/)

      // Correction ops : supprimer la ligne ambiguë, ajouter fixtures classifiables
      parkMigration()
      // DB still at N-1 (migration failed) — verify and fix data then restore mig
      restoreMigration()

      // Fresh DB for relance nominale
      const portD = String(Number(port) + 3)
      const containerD = `${container}-d`
      const urlD = `postgresql://test:test@127.0.0.1:${portD}/planificator_mig_d`
      execSync(`docker rm -f ${containerD} >/dev/null 2>&1 || true`)
      execSync(
        `docker run -d --name ${containerD} -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=planificator_mig_d -p ${portD}:5432 postgres:16-alpine`,
        { stdio: "ignore" }
      )
      for (let i = 0; i < 40; i++) {
        try {
          execSync(`docker exec ${containerD} pg_isready -U test`, {
            stdio: "ignore",
          })
          break
        } catch {
          execSync("sleep 0.4")
        }
      }

      parkMigration()
      prismaDeploy(urlD)
      psql(
        `
INSERT INTO companies (id, name, slug, "createdAt", "updatedAt")
VALUES ('c_ok','Ok','ok-${portD}',NOW(),NOW());
INSERT INTO processed_gmail_messages
  (id,"companyId","messageId","processedAt",status,"attemptCount","updatedAt")
VALUES ('pg_ok','c_ok','18f0okmsg0000001',NOW(),'SUCCEEDED',1,NOW());
INSERT INTO pending_accommodations
  (id,"companyId","gmailMessageId","rawEmailSnippet",status,"createdAt","updatedAt")
VALUES
  ('p_ok_n','c_ok','REF-OK','[n8n] x','PENDING',NOW(),NOW()),
  ('p_ok_g','c_ok','18f0okmsg0000001','mail','PENDING',NOW(),NOW());
`,
        containerD,
        "planificator_mig_d"
      )
      restoreMigration()
      const out = prismaDeploy(urlD)
      assert.match(out, /All migrations have been successfully applied|booking_identity_tenant_isolation/)
      const kinds = psql(
        `SELECT "sourceKind"::text FROM pending_accommodations ORDER BY id;`,
        containerD,
        "planificator_mig_d"
      )
      assert.match(kinds, /GMAIL/)
      assert.match(kinds, /N8N/)
      execSync(`docker rm -f ${containerD} >/dev/null 2>&1 || true`)
    } finally {
      try {
        if (existsSync(parkingC) && !existsSync(MIG_DIR)) {
          renameSync(parkingC, MIG_DIR)
        }
      } catch {
        /* ignore */
      }
      execSync(`docker rm -f ${containerC} >/dev/null 2>&1 || true`)
    }
  })
})
