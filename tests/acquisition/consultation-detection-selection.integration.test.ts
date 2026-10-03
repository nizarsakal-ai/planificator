/**
 * PLAN-ACQ-DETECTION-001 — FIX 2 : sélection Detection contre PostgreSQL réel.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent. Base jetable uniquement.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient, type WorksiteImportDraftStatus } from "@prisma/client"
import { AcquisitionConsultationDetectionSelectionRepository } from "@/lib/acquisition/detection/consultation-detection.selection.repository"
import { assertSafeDisposableTestDatabaseUrl } from "../integration/persistence/helpers/safe-test-database-url"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
if (enabled) assertSafeDisposableTestDatabaseUrl(TEST_URL!)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

const RUN_TAG = `fix2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const companyIds: string[] = []
let seq = 0

async function createCompany(label: string): Promise<string> {
  const c = await db.company.create({
    data: { name: `Detection fairness ${label}`, slug: `${RUN_TAG}-${label}` },
  })
  companyIds.push(c.id)
  return c.id
}

async function seedDraft(input: {
  companyId: string
  updatedAt: string
  status?: WorksiteImportDraftStatus
  normalizedText?: string
  detectionContentHash?: "MATCH" | "STALE" | null
}): Promise<string> {
  seq += 1
  const contentHash = `hash-${RUN_TAG}-${seq}`
  const message = await db.acquisitionMessage.create({
    data: {
      companyId: input.companyId,
      source: "GMAIL",
      externalMessageId: `ext-${RUN_TAG}-${seq}`,
      senderEmail: "ops@example.test",
      senderDomain: "example.test",
      subject: `Fairness ${seq}`,
      receivedAt: new Date(input.updatedAt),
    },
  })
  await db.acquisitionMessageContent.create({
    data: {
      companyId: input.companyId,
      acquisitionMessageId: message.id,
      normalizedText: input.normalizedText ?? `Chantier ${seq}`,
      contentHash,
      fetchedAt: new Date(input.updatedAt),
      sanitizedAt: new Date(input.updatedAt),
    },
  })
  const detection =
    input.detectionContentHash === "MATCH"
      ? contentHash
      : input.detectionContentHash === "STALE"
        ? `old-${contentHash}`
        : null
  const draft = await db.worksiteImportDraft.create({
    data: {
      companyId: input.companyId,
      acquisitionMessageId: message.id,
      status: input.status ?? "PENDING_EXTRACTION",
      ...(detection
        ? { detectionContentHash: detection, detectionClassification: "CONSULTATION" as const }
        : {}),
    },
  })
  // @updatedAt est réécrit par Prisma : fixer l’ancienneté en SQL brut.
  await db.$executeRaw`
    UPDATE "worksite_import_drafts"
    SET "updatedAt" = ${new Date(input.updatedAt)}
    WHERE "id" = ${draft.id}
  `
  return draft.id
}

describe("FIX 2 — sélection Detection équitable (PostgreSQL)", RUN, () => {
  const repo = () => new AcquisitionConsultationDetectionSelectionRepository(db)

  before(async () => {
    await db.$queryRaw`SELECT 1`
  })

  after(async () => {
    if (!enabled) return
    await db.worksiteImportDraft.deleteMany({ where: { companyId: { in: companyIds } } })
    await db.acquisitionMessageContent.deleteMany({ where: { companyId: { in: companyIds } } })
    await db.acquisitionMessage.deleteMany({ where: { companyId: { in: companyIds } } })
    await db.company.deleteMany({ where: { id: { in: companyIds } } })
    await db.$disconnect()
  })

  it("B — plus de tenants que la limite : borné, ancienneté puis tie-break companyId", async () => {
    // Années 1990 : plus anciens que toute autre donnée de ce run.
    const ages = [
      "1990-01-05T00:00:00.000Z",
      "1990-01-01T00:00:00.000Z",
      "1990-01-03T00:00:00.000Z",
      "1990-01-03T00:00:00.000Z",
      "1990-01-09T00:00:00.000Z",
      "1990-01-07T00:00:00.000Z",
    ]
    const seeded: Array<{ companyId: string; at: string }> = []
    for (const [i, at] of ages.entries()) {
      const companyId = await createCompany(`b${i}`)
      await seedDraft({ companyId, updatedAt: at })
      seeded.push({ companyId, at })
    }
    const expected = [...seeded]
      .sort((a, b) => a.at.localeCompare(b.at) || (a.companyId < b.companyId ? -1 : 1))
      .slice(0, 4)
      .map((s) => s.companyId)
    const got = await repo().listCompanyIdsNeedingDetection({ limit: 4 })
    assert.deepEqual(got, expected)
    assert.deepEqual(await repo().listCompanyIdsNeedingDetection({ limit: 4 }), got)
  })

  it("A/C — tenant lexicographiquement dernier mais plus ancien n’est pas masqué ; gros tenant = 1 rang", async () => {
    const big = await createCompany("c-big")
    for (let k = 0; k < 12; k++) {
      await seedDraft({ companyId: big, updatedAt: `1995-01-01T00:${String(k).padStart(2, "0")}:00.000Z` })
    }
    const others: string[] = []
    for (const label of ["c-x", "c-y", "c-z"]) {
      const co = await createCompany(label)
      await seedDraft({ companyId: co, updatedAt: "1995-06-01T00:00:00.000Z" })
      others.push(co)
    }
    const got = await repo().listCompanyIdsNeedingDetection({ limit: 50 })
    const mine = got.filter((id) => id === big || others.includes(id))
    assert.equal(mine.length, 4)
    assert.equal(mine[0], big)
    assert.deepEqual(new Set(mine.slice(1)), new Set(others))
    assert.equal(got.filter((id) => id === big).length, 1)
  })

  it("D/E — companyId explicite : jamais d’autre tenant ; ordre updatedAt puis id", async () => {
    const a = await createCompany("d-a")
    const b = await createCompany("d-b")
    const tieAt = "1996-01-02T00:00:00.000Z"
    const first = await seedDraft({ companyId: a, updatedAt: "1996-01-01T00:00:00.000Z" })
    const tie1 = await seedDraft({ companyId: a, updatedAt: tieAt })
    const tie2 = await seedDraft({ companyId: a, updatedAt: tieAt })
    const foreign = await seedDraft({ companyId: b, updatedAt: "1980-01-01T00:00:00.000Z" })

    const rows = await repo().listCandidatesForCompany({ companyId: a, limit: 10 })
    assert.ok(rows.every((r) => r.companyId === a))
    assert.ok(!rows.some((r) => r.draftId === foreign))
    assert.deepEqual(
      rows.map((r) => r.draftId),
      [first, ...[tie1, tie2].sort()]
    )
    const limited = await repo().listCandidatesForCompany({ companyId: a, limit: 2 })
    assert.equal(limited.length, 2)
  })

  it("F — éligibilité inchangée : preuve fraîche / statut hors scope / contenu vide exclus", async () => {
    const co = await createCompany("f")
    const at = "1997-01-01T00:00:00.000Z"
    const noProof = await seedDraft({ companyId: co, updatedAt: at })
    const staleProof = await seedDraft({ companyId: co, updatedAt: at, detectionContentHash: "STALE" })
    const failed = await seedDraft({ companyId: co, updatedAt: at, status: "FAILED" })
    const extracting = await seedDraft({ companyId: co, updatedAt: at, status: "EXTRACTING" })
    const freshProof = await seedDraft({ companyId: co, updatedAt: at, detectionContentHash: "MATCH" })
    const pendingReview = await seedDraft({ companyId: co, updatedAt: at, status: "PENDING_REVIEW" })
    const emptyText = await seedDraft({ companyId: co, updatedAt: at, normalizedText: "" })

    const ids = (await repo().listCandidatesForCompany({ companyId: co, limit: 50 })).map((r) => r.draftId)
    for (const included of [noProof, staleProof, failed, extracting]) {
      assert.ok(ids.includes(included), `éligible manquant ${included}`)
    }
    for (const excluded of [freshProof, pendingReview, emptyText]) {
      assert.ok(!ids.includes(excluded), `non éligible sélectionné ${excluded}`)
    }

    // Tenant dont tous les drafts sont non éligibles → absent de la sélection tenants.
    const ineligible = await createCompany("f-none")
    await seedDraft({ companyId: ineligible, updatedAt: "1970-01-01T00:00:00.000Z", detectionContentHash: "MATCH" })
    const companies = await repo().listCompanyIdsNeedingDetection({ limit: 1000 })
    assert.ok(!companies.includes(ineligible))
  })
})
