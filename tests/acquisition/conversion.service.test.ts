process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
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

type FakeDb = {
  draft: Draft
  worksites: Array<{ id: string; clientId: string; companyId: string }>
  documents: Array<{
    id: string
    worksiteId: string
    sourceAcquisitionAttachmentId: string | null
    url: string | null
  }>
  teams: number
  assignments: number
  worksiteImportDraft: {
    findFirst: (args: {
      where: Record<string, unknown>
      select?: Record<string, unknown>
    }) => Promise<unknown>
    updateMany: (args: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }) => Promise<{ count: number }>
  }
  client: {
    findFirst: (args: { where: { id: string; companyId: string } }) => Promise<unknown>
    create: (args: {
      data: { name: string; companyId: string }
      select?: { id: boolean }
    }) => Promise<{ id: string }>
  }
  worksite: {
    create: (args: {
      data: { clientId: string; companyId: string; name: string }
      select?: { id: boolean }
    }) => Promise<{ id: string }>
  }
  acquisitionAttachment: {
    findMany: (args: {
      where: { companyId: string; acquisitionMessageId: string }
    }) => Promise<unknown[]>
  }
  document: {
    create: (args: {
      data: {
        worksiteId: string
        url: string | null
        sourceAcquisitionAttachmentId: string
        storagePublicId: string
      }
    }) => Promise<{ id: string }>
    count: (args: { where: { worksiteId: string } }) => Promise<number>
  }
  team: { create: () => Promise<void> | void }
  assignment: { create: () => Promise<void> | void }
  $transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>
}

function createFakeDb(seed: {
  draft: Draft
  clients?: Array<{ id: string; companyId: string }>
  forceClaimFail?: boolean
  attachments?: Array<{
    id: string
    companyId: string
    acquisitionMessageId: string
    filename: string
    mimeType: string
    sizeBytes: number
    category: "PLAN" | "PHOTO" | "DOCUMENT" | "UNKNOWN"
    status: string
    storagePublicId: string | null
  }>
}): FakeDb {
  let draft = { ...seed.draft }
  const clients = [...(seed.clients ?? [])]
  const attachments = [...(seed.attachments ?? [])]
  const worksites: Array<{ id: string; clientId: string; companyId: string }> = []
  const documents: Array<{
    id: string
    worksiteId: string
    sourceAcquisitionAttachmentId: string | null
    url: string | null
  }> = []
  let teams = 0
  let assignments = 0
  const forceClaimFail = seed.forceClaimFail ?? false

  const api: FakeDb = {
    get draft() {
      return draft
    },
    get worksites() {
      return worksites
    },
    get documents() {
      return documents
    },
    get teams() {
      return teams
    },
    get assignments() {
      return assignments
    },
    worksiteImportDraft: {
      async findFirst(args: { where: Record<string, unknown>; select?: Record<string, unknown> }) {
        const w = args.where
        if (w.id !== draft.id) return null
        if (w.companyId && w.companyId !== draft.companyId) return null
        const createdWorksite = worksites.find((x) => x.id === draft.createdWorksiteId) ?? null
        return {
          ...draft,
          createdWorksite: createdWorksite
            ? { id: createdWorksite.id, clientId: createdWorksite.clientId }
            : null,
        }
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        if (forceClaimFail) return { count: 0 }
        const w = args.where
        if (w.id !== draft.id || w.companyId !== draft.companyId) return { count: 0 }
        if (typeof w.version === "number" && w.version !== draft.version) return { count: 0 }
        if (typeof w.status === "string" && w.status !== draft.status) return { count: 0 }
        const data = { ...args.data }
        if (data.version && typeof data.version === "object" && "increment" in (data.version as object)) {
          draft.version += Number((data.version as { increment: number }).increment)
          delete data.version
        }
        draft = { ...draft, ...data } as Draft
        return { count: 1 }
      },
    },
    client: {
      async findFirst(args: { where: { id: string; companyId: string } }) {
        return clients.find((c) => c.id === args.where.id && c.companyId === args.where.companyId) ?? null
      },
      async create(args: { data: { name: string; companyId: string }; select?: { id: boolean } }) {
        const id = `client-${clients.length + 1}`
        clients.push({ id, companyId: args.data.companyId })
        return { id }
      },
    },
    worksite: {
      async create(args: {
        data: { clientId: string; companyId: string; name: string }
        select?: { id: boolean }
      }) {
        const id = `ws-${worksites.length + 1}`
        worksites.push({
          id,
          clientId: args.data.clientId,
          companyId: args.data.companyId,
        })
        return { id }
      },
    },
    acquisitionAttachment: {
      async findMany(args: {
        where: { companyId: string; acquisitionMessageId: string }
      }) {
        return attachments.filter(
          (a) =>
            a.companyId === args.where.companyId &&
            a.acquisitionMessageId === args.where.acquisitionMessageId
        )
      },
    },
    document: {
      async create(args: {
        data: {
          worksiteId: string
          url: string | null
          sourceAcquisitionAttachmentId: string
          storagePublicId: string
        }
      }) {
        documents.push({
          id: `doc-${documents.length + 1}`,
          worksiteId: args.data.worksiteId,
          sourceAcquisitionAttachmentId: args.data.sourceAcquisitionAttachmentId,
          url: args.data.url,
        })
        return { id: `doc-${documents.length}` }
      },
      async count(args: { where: { worksiteId: string } }) {
        return documents.filter((d) => d.worksiteId === args.where.worksiteId).length
      },
    },
    team: {
      async create() {
        teams++
      },
    },
    assignment: {
      async create() {
        assignments++
      },
    },
    async $transaction<T>(fn: (tx: FakeDb) => Promise<T>) {
      const snap = {
        draft: { ...draft },
        clientsLen: clients.length,
        worksitesLen: worksites.length,
        documentsLen: documents.length,
      }
      try {
        return await fn(api)
      } catch (e) {
        draft = snap.draft
        clients.length = snap.clientsLen
        worksites.length = snap.worksitesLen
        documents.length = snap.documentsLen
        throw e
      }
    },
  }

  return api
}

const admin: ConversionActorContext = {
  actorUserId: "u-admin",
  actorRole: "ADMIN",
  companyId: "co1",
}

function baseDraft(over: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    companyId: "co1",
    status: "APPROVED",
    version: 2,
    acquisitionMessageId: "msg1",
    proposedWorksiteName: "Tour Alpha",
    proposedDescription: "Desc",
    proposedAddress: "1 rue X",
    proposedPostalCode: "75001",
    proposedCity: "Paris",
    proposedStartDate: new Date("2026-10-01T00:00:00.000Z"),
    proposedEndDate: new Date("2026-10-15T00:00:00.000Z"),
    createdWorksiteId: null,
    ...over,
  }
}

describe("ImportDraftConversionService", () => {
  const env = { ...process.env }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
  })

  afterEach(() => {
    process.env = { ...env }
  })

  it("EXISTING → CONVERTED + documents STORED seulement", async () => {
    const db = createFakeDb({
      draft: baseDraft(),
      clients: [{ id: "c1", companyId: "co1" }],
      attachments: [
        {
          id: "a1",
          companyId: "co1",
          acquisitionMessageId: "msg1",
          filename: "plan.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          category: "PLAN",
          status: "STORED",
          storagePublicId: "pid/1",
        },
        {
          id: "a2",
          companyId: "co1",
          acquisitionMessageId: "msg1",
          filename: "x.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1,
          category: "UNKNOWN",
          status: "FAILED",
          storagePublicId: null,
        },
      ],
    })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 2,
      clientMode: "EXISTING",
      existingClientId: "c1",
    })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.outcome, "CONVERTED")
      assert.equal(r.clientCreated, false)
      assert.equal(r.documentCount, 1)
      assert.equal(r.skippedAttachmentCount, 1)
    }
    assert.equal(db.draft.status, "CONVERTED")
    assert.equal(db.documents[0]?.url, null)
    assert.equal(db.teams + db.assignments, 0)
  })

  it("NEW crée client", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 2,
      clientMode: "NEW",
      newClient: { name: "Nouveau", email: null, phone: null, address: null },
    })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.clientCreated, true)
  })

  it("EXISTING cross-tenant → CLIENT_NOT_FOUND", async () => {
    const db = createFakeDb({
      draft: baseDraft(),
      clients: [{ id: "c1", companyId: "other" }],
    })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 2,
      clientMode: "EXISTING",
      existingClientId: "c1",
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "CLIENT_NOT_FOUND")
    assert.equal(db.worksites.length, 0)
  })

  it("version conflict → rollback + STATE_CHANGED", async () => {
    const db = createFakeDb({
      draft: baseDraft({ version: 5 }),
      clients: [{ id: "c1", companyId: "co1" }],
    })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 2,
      clientMode: "EXISTING",
      existingClientId: "c1",
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "STATE_CHANGED")
    assert.equal(db.worksites.length, 0)
    assert.equal(db.draft.status, "APPROVED")
  })

  it("déjà CONVERTED → ALREADY_CONVERTED", async () => {
    const db = createFakeDb({
      draft: baseDraft({ status: "CONVERTED", createdWorksiteId: "ws-1", version: 9 }),
      clients: [{ id: "c1", companyId: "co1" }],
    })
    db.worksites.push({ id: "ws-1", clientId: "c1", companyId: "co1" })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 9,
      clientMode: "EXISTING",
      existingClientId: "c1",
    })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.outcome, "ALREADY_CONVERTED")
  })

  it("claim final count=0 → rollback Client/Worksite/Documents + STATE_CHANGED", async () => {
    const db = createFakeDb({
      draft: baseDraft(),
      clients: [{ id: "c1", companyId: "co1" }],
      forceClaimFail: true,
      attachments: [
        {
          id: "a1",
          companyId: "co1",
          acquisitionMessageId: "msg1",
          filename: "plan.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          category: "PLAN",
          status: "STORED",
          storagePublicId: "pid/1",
        },
      ],
    })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 2,
      clientMode: "EXISTING",
      existingClientId: "c1",
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "STATE_CHANGED")
    assert.equal(db.worksites.length, 0)
    assert.equal(db.documents.length, 0)
    assert.equal(db.draft.status, "APPROVED")
    assert.equal(db.draft.createdWorksiteId, null)
  })

  it("nom chantier > 100 → VALIDATION_ERROR", async () => {
    const db = createFakeDb({
      draft: baseDraft({ proposedWorksiteName: "x".repeat(101) }),
    })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 2,
      clientMode: "NEW",
      newClient: { name: "X", email: null, phone: null, address: null },
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "VALIDATION_ERROR")
    assert.equal(db.worksites.length, 0)
  })

  it("flags OFF → DISABLED", async () => {
    process.env.ACQUISITION_CONVERSION_ENABLED = "false"
    const db = createFakeDb({ draft: baseDraft() })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(admin, {
      draftId: "d1",
      expectedVersion: 2,
      clientMode: "NEW",
      newClient: { name: "X", email: null, phone: null, address: null },
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "DISABLED")
  })

  it("EMPLOYEE interdit", async () => {
    const db = createFakeDb({ draft: baseDraft() })
    const svc = new ImportDraftConversionService({ db: db as never })
    const r = await svc.convertImportDraft(
      { actorUserId: "e", actorRole: "EMPLOYEE", companyId: "co1" },
      {
        draftId: "d1",
        expectedVersion: 2,
        clientMode: "NEW",
        newClient: { name: "X", email: null, phone: null, address: null },
      }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "FORBIDDEN")
  })
})
