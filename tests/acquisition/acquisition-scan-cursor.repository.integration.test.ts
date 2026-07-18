process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { AcquisitionScanCursorRepository } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

let companyA = ""
let companyB = ""

describe("AcquisitionScanCursorRepository — intégration", RUN, () => {
  before(async () => {
    const a = await db.company.create({
      data: { name: "Cursor Test A", slug: `cursor-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Cursor Test B", slug: `cursor-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id
  })

  after(async () => {
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("getOrCreate crée un curseur par [companyId, source]", async () => {
    const repo = new AcquisitionScanCursorRepository(db)
    const c1 = await repo.getOrCreate(companyA, "GMAIL")
    assert.equal(c1.companyId, companyA)
    assert.equal(c1.source, "GMAIL")
    assert.equal(c1.consecutiveFailures, 0)

    const c2 = await repo.getOrCreate(companyA, "GMAIL")
    assert.equal(c2.id, c1.id)
  })

  it("deux tenants peuvent posséder le même lastHistoryId provider", async () => {
    const repo = new AcquisitionScanCursorRepository(db)
    const sharedHistory = "provider-history-999"

    await repo.saveSuccessfulPage(companyA, "GMAIL", sharedHistory, new Date())
    await repo.saveSuccessfulPage(companyB, "GMAIL", sharedHistory, new Date())

    const a = await repo.getOrCreate(companyA, "GMAIL")
    const b = await repo.getOrCreate(companyB, "GMAIL")
    assert.equal(a.lastHistoryId, sharedHistory)
    assert.equal(b.lastHistoryId, sharedHistory)
    assert.notEqual(a.id, b.id)
  })

  it("saveSuccessfulPage remet consecutiveFailures à zéro", async () => {
    const repo = new AcquisitionScanCursorRepository(db)
    await repo.recordFailure(companyA, "GMAIL", "TEST_ERROR", new Date())
    const failed = await repo.getOrCreate(companyA, "GMAIL")
    assert.ok(failed.consecutiveFailures >= 1)

    const ok = await repo.saveSuccessfulPage(companyA, "GMAIL", "hist-ok", new Date())
    assert.equal(ok.consecutiveFailures, 0)
    assert.equal(ok.lastErrorCode, null)
  })

  it("recordFailure incrémente consecutiveFailures", async () => {
    const repo = new AcquisitionScanCursorRepository(db)
    const before = await repo.getOrCreate(companyB, "GMAIL")
    const after = await repo.recordFailure(companyB, "GMAIL", "PROVIDER_DOWN", new Date())
    assert.equal(after.consecutiveFailures, before.consecutiveFailures + 1)
    assert.equal(after.lastErrorCode, "PROVIDER_DOWN")
  })

  it("unicité [companyId, source] en base", async () => {
    const count = await db.acquisitionScanCursor.count({
      where: { companyId: companyA, source: "GMAIL" },
    })
    assert.equal(count, 1)
  })

  it("ne lit jamais le curseur d'un autre tenant", async () => {
    const repo = new AcquisitionScanCursorRepository(db)
    await repo.saveSuccessfulPage(companyA, "GMAIL", "only-a", new Date())

    const b = await repo.getOrCreate(companyB, "GMAIL")
    assert.notEqual(b.lastHistoryId, "only-a")
  })
})
