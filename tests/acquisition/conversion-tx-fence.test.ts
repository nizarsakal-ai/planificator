/**
 * PLAN-ACQ-AGENTS-LOT-3F — Fence transactionnel conversion (unit).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
process.env.ACQUISITION_CONVERSION_ENABLED = "true"

import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
import type { ConversionTransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import type { ConversionActorContext } from "@/lib/acquisition/conversion/conversion.types"

type Draft = {
  id: string
  companyId: string
  status: string
  version: number
  acquisitionMessageId: string
  proposedWorksiteName: string | null
  proposedDescription: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  proposedStartDate: Date | null
  proposedEndDate: Date | null
  createdWorksiteId: string | null
}

function baseDraft(over: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    companyId: "co1",
    status: "APPROVED",
    version: 2,
    acquisitionMessageId: "m1",
    proposedWorksiteName: "Chantier Test",
    proposedDescription: null,
    proposedAddress: "1 rue A",
    proposedPostalCode: "69001",
    proposedCity: "Lyon",
    proposedStartDate: new Date("2026-09-10"),
    proposedEndDate: new Date("2026-09-12"),
    createdWorksiteId: null,
    ...over,
  }
}

function createFakeDb(seed: { draft: Draft; clients?: Array<{ id: string; companyId: string }> }) {
  const draft = { ...seed.draft }
  const clients = [...(seed.clients ?? [{ id: "c1", companyId: "co1" }])]
  const worksites: Array<{ id: string; clientId: string; companyId: string }> = []
  const documents: unknown[] = []
  const order: string[] = []

  const api: {
    draft: Draft
    worksites: typeof worksites
    documents: unknown[]
    order: string[]
    worksiteImportDraft: {
      findFirst: () => Promise<Record<string, unknown>>
      updateMany: (args: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => Promise<{ count: number }>
    }
    client: {
      findFirst: (args: { where: { id: string; companyId: string } }) => Promise<unknown>
      create: () => Promise<{ id: string }>
    }
    worksite: {
      findMany: () => Promise<unknown[]>
      create: (args: {
        data: { clientId: string; companyId: string; name: string }
      }) => Promise<{ id: string }>
    }
    acquisitionAttachment: { findMany: () => Promise<unknown[]> }
    document: {
      create: () => Promise<{ id: string }>
      count: () => Promise<number>
    }
    $transaction: <T>(fn: (tx: typeof api) => Promise<T>) => Promise<T>
  } = {
    draft,
    worksites,
    documents,
    order,
    worksiteImportDraft: {
      findFirst: async () => ({
        ...draft,
        createdWorksite: draft.createdWorksiteId
          ? { id: draft.createdWorksiteId, clientId: "c1" }
          : null,
      }),
      updateMany: async (args: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        order.push("draft.updateMany")
        if (
          draft.id === args.where.id &&
          draft.companyId === args.where.companyId &&
          draft.status === args.where.status &&
          draft.version === args.where.version
        ) {
          Object.assign(draft, args.data)
          if (
            args.data.version &&
            typeof args.data.version === "object" &&
            "increment" in (args.data.version as object)
          ) {
            draft.version += Number(
              (args.data.version as { increment: number }).increment
            )
          }
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    client: {
      findFirst: async (args: { where: { id: string; companyId: string } }) =>
        clients.find(
          (c) => c.id === args.where.id && c.companyId === args.where.companyId
        ) ?? null,
      create: async () => {
        order.push("client.create")
        const id = `c-new-${clients.length}`
        clients.push({ id, companyId: draft.companyId })
        return { id }
      },
    },
    worksite: {
      findMany: async () => [],
      create: async (args: {
        data: { clientId: string; companyId: string; name: string }
      }) => {
        order.push("worksite.create")
        const id = `ws-${worksites.length}`
        worksites.push({
          id,
          clientId: args.data.clientId,
          companyId: args.data.companyId,
        })
        return { id }
      },
    },
    acquisitionAttachment: {
      findMany: async () => [],
    },
    document: {
      create: async () => {
        order.push("document.create")
        documents.push({})
        return { id: `doc-${documents.length}` }
      },
      count: async () => documents.length,
    },
    async $transaction<T>(fn: (tx: typeof api) => Promise<T>) {
      return fn(api)
    },
  }
  return api
}

describe("LOT-3F — conversion transactional ownership fence", () => {
  const prevAcq = process.env.PLANIFICATOR_ACQUISITION_ENABLED
  const prevConv = process.env.ACQUISITION_CONVERSION_ENABLED

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
  })
  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = prevAcq
    process.env.ACQUISITION_CONVERSION_ENABLED = prevConv
  })

  const admin: ConversionActorContext = {
    actorUserId: "admin1",
    actorRole: "ADMIN",
    companyId: "co1",
  }
  const system: ConversionActorContext = {
    actorUserId: "sys1",
    actorRole: "SYSTEM",
    companyId: "co1",
  }

  const convertBody = {
    draftId: "d1",
    expectedVersion: 2,
    clientMode: "EXISTING" as const,
    existingClientId: "c1",
  }

  it("A — conversion manuelle sans fence : historique OK", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, convertBody)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.outcome, "CONVERTED")
    assert.equal(db.draft.status, "CONVERTED")
    assert.equal(db.worksites.length, 1)
  })

  it("B — SYSTEM + fence OWNED → conversion autorisée", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    const sequence: string[] = []
    const fence: ConversionTransactionalOwnershipFence = {
      async assertOwnedAndLock() {
        sequence.push("fence")
        return "OWNED"
      },
    }
    const origCreate = db.worksite.create.bind(db.worksite)
    db.worksite.create = async (args) => {
      sequence.push("worksite.create")
      return origCreate(args)
    }
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(system, convertBody, {
      transactionalOwnershipFence: fence,
    })
    assert.equal(r.ok, true)
    assert.equal(sequence[0], "fence")
    assert.ok(sequence.indexOf("worksite.create") > sequence.indexOf("fence"))
  })

  it("C — SYSTEM + fence NOT_OWNED → zéro mutation", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    const fence: ConversionTransactionalOwnershipFence = {
      async assertOwnedAndLock() {
        return "NOT_OWNED"
      },
    }
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(system, convertBody, {
      transactionalOwnershipFence: fence,
    })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "LEASE_NOT_OWNED")
      assert.equal(r.code, "LEASE_NOT_OWNED")
      assert.equal(r.message.includes("sys1"), false)
    }
    assert.equal(db.worksites.length, 0)
    assert.equal(db.documents.length, 0)
    assert.equal(db.draft.status, "APPROVED")
    assert.equal(db.order.includes("client.create"), false)
    assert.equal(db.order.includes("worksite.create"), false)
  })

  it("D — fence throw → fail-closed, zéro mutation", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    const fence: ConversionTransactionalOwnershipFence = {
      async assertOwnedAndLock() {
        throw new Error("fence boom")
      },
    }
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(system, convertBody, {
      transactionalOwnershipFence: fence,
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "INTERNAL_ERROR")
    assert.equal(db.worksites.length, 0)
    assert.equal(db.draft.status, "APPROVED")
  })

  it("E — SYSTEM sans fence → LEASE_NOT_OWNED / zéro mutation", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    let findFirstCalls = 0
    const origFind = db.worksiteImportDraft.findFirst.bind(db.worksiteImportDraft)
    db.worksiteImportDraft.findFirst = async () => {
      findFirstCalls++
      return origFind()
    }
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(system, convertBody)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "LEASE_NOT_OWNED")
      assert.equal(r.code, "LEASE_NOT_OWNED")
    }
    assert.equal(findFirstCalls, 0)
    assert.equal(db.draft.status, "APPROVED")
    assert.equal(db.worksites.length, 0)
    assert.equal(db.documents.length, 0)
    assert.equal(db.order.includes("client.create"), false)
    assert.equal(db.order.includes("worksite.create"), false)
    assert.equal(db.order.includes("draft.updateMany"), false)
  })

  it("E2 — SYSTEM sans fence + CONVERTED → LEASE_NOT_OWNED (jamais ALREADY_CONVERTED)", async () => {
    const db = createFakeDb({
      draft: baseDraft({
        status: "CONVERTED",
        createdWorksiteId: "ws-existing",
      }),
    })
    let findFirstCalls = 0
    const origFind = db.worksiteImportDraft.findFirst.bind(db.worksiteImportDraft)
    db.worksiteImportDraft.findFirst = async () => {
      findFirstCalls++
      return origFind()
    }
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(system, convertBody)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "LEASE_NOT_OWNED")
      assert.notEqual(r.outcome, "ALREADY_CONVERTED")
    }
    assert.equal(findFirstCalls, 0)
  })

  it("E3 — SYSTEM sans fence + non APPROVED → LEASE_NOT_OWNED (jamais INVALID_STATE)", async () => {
    const db = createFakeDb({
      draft: baseDraft({ status: "PENDING_REVIEW" }),
    })
    let findFirstCalls = 0
    const origFind = db.worksiteImportDraft.findFirst.bind(db.worksiteImportDraft)
    db.worksiteImportDraft.findFirst = async () => {
      findFirstCalls++
      return origFind()
    }
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(system, convertBody)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "LEASE_NOT_OWNED")
      assert.notEqual(r.outcome, "INVALID_STATE")
    }
    assert.equal(findFirstCalls, 0)
  })

  it("F — fence avant toute mutation métier (ordre)", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    const sequence: string[] = []
    const fence: ConversionTransactionalOwnershipFence = {
      async assertOwnedAndLock() {
        sequence.push("fence")
        return "OWNED"
      },
    }
    const origCreate = db.worksite.create.bind(db.worksite)
    db.worksite.create = async (args) => {
      sequence.push("worksite")
      return origCreate(args)
    }
    const svc = new ImportDraftConversionService({ db: db as never })
    await svc.convertImportDraft(system, convertBody, {
      transactionalOwnershipFence: fence,
    })
    assert.deepEqual(sequence.slice(0, 2), ["fence", "worksite"])
  })

  it("aucun hook test-only production dans conversion.service", () => {
    const src = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/acquisition/conversion/conversion.service.ts"
      ),
      "utf8"
    )
    assert.equal(/__test/.test(src), false)
  })
})
