/**
 * PLAN-ACQ-AGENTS-LOT-3D-CORRECTION-3 — Fairness inter-tenant (PostgreSQL).
 * Nécessite TEST_ACQUISITION_DATABASE_URL ; skip sinon.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { createPrismaValidationSelectionPort } from "@/lib/acquisition/orchestrator/acquisition-validation.worker"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

const TENANT_COUNT = 30
const MAX_CANDIDATES = 25
const SCHEMA_V = "2"
const HASH_PREFIX = "fair-hash-"

type SeededTenant = {
  companyId: string
  draftId: string
  index: number
  oldestEligibleAt: Date
  hash: string
}

describe("LOT-3D-CORRECTION-3 — fairness inter-tenant PostgreSQL", RUN, () => {
  const stamp = Date.now()
  const tenants: SeededTenant[] = []
  let tieCompanyA = ""
  let tieCompanyB = ""
  let tieDraftA = ""
  let tieDraftB = ""

  async function seedEligibleDraft(
    companyId: string,
    index: number,
    updatedAt: Date,
    hash: string
  ): Promise<string> {
    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-fair-${stamp}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        senderEmail: "carlene@lauralu.fr",
        subject: `Fairness ${index}`,
        receivedAt: new Date(),
        attachments: [],
      },
      db
    )
    assert.equal(reg.outcome, "DRAFT_CREATED")
    assert.ok(reg.draftId)
    await db.worksiteImportDraft.update({
      where: { id: reg.draftId! },
      data: {
        status: "PENDING_REVIEW",
        version: 1,
        contentHashAtExtraction: hash,
        extractionSchemaVersion: SCHEMA_V,
        proposedWorksiteName: `Site ${index}`,
      },
    })
    await db.$executeRaw`
      UPDATE "worksite_import_drafts"
      SET "updatedAt" = ${updatedAt}
      WHERE id = ${reg.draftId!}
    `
    return reg.draftId!
  }

  async function markCycleTerminal(companyId: string, draftId: string, hash: string) {
    await db.acquisitionDecisionJournal.create({
      data: {
        companyId,
        draftId,
        decisionCode: "VALIDATION_PASS",
        reasons: ["FAIRNESS_TEST"],
        scores: {},
        metadata: {
          contentHash: hash,
          extractionSchemaVersion: SCHEMA_V,
          draftVersion: 1,
        },
      },
    })
  }

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const base = Date.UTC(2026, 0, 1, 0, 0, 0)

    for (let i = 0; i < TENANT_COUNT; i++) {
      const company = await db.company.create({
        data: {
          name: `Fair ${i}`,
          slug: `fair-${stamp}-${String(i).padStart(2, "0")}`,
        },
      })
      await seedLauraluPartnerForCompany(db, company.id)
      const oldestEligibleAt = new Date(base + i * 3_600_000)
      const hash = `${HASH_PREFIX}${i}`
      const draftId = await seedEligibleDraft(company.id, i, oldestEligibleAt, hash)
      tenants.push({
        companyId: company.id,
        draftId,
        index: i,
        oldestEligibleAt,
        hash,
      })
    }

    // maxPerCompany fixture : 3 drafts supplémentaires sur tenant 0 uniquement
    for (let j = 0; j < 3; j++) {
      await seedEligibleDraft(
        tenants[0]!.companyId,
        1000 + j,
        new Date(base + (j + 1) * 60_000),
        `${HASH_PREFIX}0-extra-${j}`
      )
    }

    // Tie-break : même oldestEligibleAt, companyId distincts
    const tieAt = new Date(base + 100 * 3_600_000)
    const ca = await db.company.create({
      data: { name: "Tie A", slug: `fair-tie-a-${stamp}` },
    })
    const cb = await db.company.create({
      data: { name: "Tie B", slug: `fair-tie-b-${stamp}` },
    })
    tieCompanyA = ca.id
    tieCompanyB = cb.id
    await seedLauraluPartnerForCompany(db, ca.id)
    await seedLauraluPartnerForCompany(db, cb.id)
    tieDraftA = await seedEligibleDraft(ca.id, 2000, tieAt, `${HASH_PREFIX}tie-a`)
    tieDraftB = await seedEligibleDraft(cb.id, 2001, tieAt, `${HASH_PREFIX}tie-b`)
  })

  after(async () => {
    if (!enabled) return
    const companyIds = [
      ...tenants.map((t) => t.companyId),
      tieCompanyA,
      tieCompanyB,
    ].filter(Boolean)
    await db.acquisitionDecisionJournal.deleteMany({
      where: { companyId: { in: companyIds } },
    })
    await db.worksiteImportDraft.deleteMany({ where: { companyId: { in: companyIds } } })
    await db.acquisitionMessageContent.deleteMany({
      where: { companyId: { in: companyIds } },
    })
    await db.acquisitionMessage.deleteMany({ where: { companyId: { in: companyIds } } })
    await db.acquisitionPartnerDomain.deleteMany({
      where: { companyId: { in: companyIds } },
    })
    await db.acquisitionPartner.deleteMany({ where: { companyId: { in: companyIds } } })
    await db.company.deleteMany({ where: { id: { in: companyIds } } })
    await db.$disconnect()
  })

  it("run1 oldest 25 ; progression ; run2 sert les 5 affamés ; maxPerCompany ; isolation", async () => {
    const port = createPrismaValidationSelectionPort(db)
    const now = new Date("2026-08-01T12:00:00.000Z")
    // maxPerCompany=1 → exactement 25 tenants distincts au run1
    const maxPerCompany = 1

    const run1 = await port.listEligibleCandidates({
      limit: MAX_CANDIDATES,
      now,
      maxPerCompany,
    })
    assert.equal(run1.length, MAX_CANDIDATES)

    const fromTenant0 = run1.filter((r) => r.companyId === tenants[0]!.companyId)
    assert.equal(fromTenant0.length, 1, "maxPerCompany=1")

    for (const row of run1) {
      const dbRow = await db.worksiteImportDraft.findFirst({
        where: { id: row.draftId, companyId: row.companyId },
        select: { id: true },
      })
      assert.ok(dbRow, `isolation: draft ${row.draftId} → ${row.companyId}`)
    }

    const run1Companies = new Set(run1.map((r) => r.companyId))
    assert.equal(run1Companies.size, MAX_CANDIDATES)
    const expectedServed = tenants.slice(0, MAX_CANDIDATES)
    const starved = tenants.slice(MAX_CANDIDATES)
    for (const t of expectedServed) {
      assert.ok(run1Companies.has(t.companyId), `ancien tenant ${t.index} servi run1`)
    }
    for (const t of starved) {
      assert.equal(run1Companies.has(t.companyId), false, `tenant ${t.index} affamé run1`)
    }

    const firstSeen: string[] = []
    for (const row of run1) {
      if (!firstSeen.includes(row.companyId)) firstSeen.push(row.companyId)
    }
    const oldestMap = new Map(tenants.map((t) => [t.companyId, t.oldestEligibleAt.getTime()]))
    for (let i = 1; i < firstSeen.length; i++) {
      const prev = oldestMap.get(firstSeen[i - 1]!)!
      const cur = oldestMap.get(firstSeen[i]!)!
      assert.ok(prev <= cur, "oldestEligibleAt ASC")
    }

    for (const row of run1) {
      await markCycleTerminal(row.companyId, row.draftId, row.contentHashAtExtraction)
    }

    const run2 = await port.listEligibleCandidates({
      limit: MAX_CANDIDATES,
      now,
      maxPerCompany,
    })
    const run2Companies = new Set(run2.map((r) => r.companyId))
    for (const t of starved) {
      assert.ok(run2Companies.has(t.companyId), `tenant affamé ${t.index} au run2`)
    }

    // maxPerCompany avec extras restants sur tenant0
    const run2b = await port.listEligibleCandidates({
      limit: 10,
      now,
      maxPerCompany: 2,
    })
    const t0count = run2b.filter((r) => r.companyId === tenants[0]!.companyId).length
    assert.ok(t0count <= 2, "maxPerCompany=2 borné")
    for (const row of run2b) {
      const dbRow = await db.worksiteImportDraft.findFirst({
        where: { id: row.draftId, companyId: row.companyId },
      })
      assert.ok(dbRow)
    }
  })

  it("tie-break companyId ASC quand oldestEligibleAt identique", async () => {
    // Neutraliser les 30 tenants + extras pour n’observer que la paire tie
    for (const t of tenants) {
      await markCycleTerminal(t.companyId, t.draftId, t.hash)
    }
    const extras = await db.worksiteImportDraft.findMany({
      where: {
        companyId: tenants[0]!.companyId,
        id: { not: tenants[0]!.draftId },
        status: "PENDING_REVIEW",
        contentHashAtExtraction: { not: null },
      },
      select: { id: true, contentHashAtExtraction: true, companyId: true },
    })
    for (const e of extras) {
      if (!e.contentHashAtExtraction) continue
      await markCycleTerminal(e.companyId, e.id, e.contentHashAtExtraction)
    }

    const port = createPrismaValidationSelectionPort(db)
    const rows = await port.listEligibleCandidates({
      limit: 10,
      now: new Date("2026-08-01T12:00:00.000Z"),
      maxPerCompany: 1,
    })
    const tieRows = rows.filter(
      (r) => r.companyId === tieCompanyA || r.companyId === tieCompanyB
    )
    assert.ok(tieRows.length >= 2)
    const ordered = [tieCompanyA, tieCompanyB].sort()
    const firstIdx = rows.findIndex((r) => r.companyId === ordered[0])
    const secondIdx = rows.findIndex((r) => r.companyId === ordered[1])
    assert.ok(firstIdx >= 0 && secondIdx >= 0)
    assert.ok(firstIdx < secondIdx, "companyId ASC en tie")
    void tieDraftA
    void tieDraftB
  })
})
