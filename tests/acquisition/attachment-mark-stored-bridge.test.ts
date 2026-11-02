process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { PrismaClient } from "@prisma/client"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"

type AttachmentRow = {
  id: string
  companyId: string
  acquisitionMessageId: string
  externalAttachmentId: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  category: "PLAN" | "PHOTO" | "DOCUMENT" | "ARCHIVE" | "UNSUPPORTED" | "UNKNOWN"
  status: "DISCOVERED" | "PENDING_DOWNLOAD" | "STORED" | "REJECTED" | "FAILED"
  sha256: string | null
  storageUrl: string | null
  storagePublicId: string | null
  storedAt: Date | null
  lastErrorCode: string | null
  downloadClaimedAt: Date | null
  downloadRetryCount: number
  downloadNextRetryAt: Date | null
}

type DraftRow = { id: string; status: string; createdWorksiteId: string | null; acquisitionMessageId: string; companyId: string }
type DocumentRow = { sourceAcquisitionAttachmentId: string; worksiteId: string; type: string }

function pendingAttachment(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: "att-1",
    companyId: "co-1",
    acquisitionMessageId: "msg-1",
    externalAttachmentId: "ext-1",
    filename: "plan.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    category: "PLAN",
    status: "PENDING_DOWNLOAD",
    sha256: null,
    storageUrl: null,
    storagePublicId: null,
    storedAt: null,
    lastErrorCode: null,
    downloadClaimedAt: new Date("2026-10-31T10:00:00Z"),
    downloadRetryCount: 0,
    downloadNextRetryAt: null,
    ...over,
  }
}

const STORED_UPDATE = {
  sha256: "a".repeat(64),
  storageUrl: "https://cloudinary.test/file",
  storagePublicId: "acq/co-1/plan",
  storedAt: new Date("2026-10-31T10:05:00Z"),
  sizeBytes: 2048,
  mimeType: "application/pdf",
}

/**
 * Faux client qui simule la transaction (snapshot + rollback), les verrous (journal d'événements)
 * et les injections d'erreur. Le vrai comportement PostgreSQL (attente de verrou, READ COMMITTED)
 * est couvert par les sondes PG à deux connexions, pas ici.
 */
function makeDb(seed: {
  attachments: AttachmentRow[]
  drafts?: DraftRow[]
  worksites?: Array<{ id: string; companyId: string }>
  documents?: DocumentRow[]
  failOn?: "lock" | "document"
}) {
  let attachments = seed.attachments.map((a) => ({ ...a }))
  let documents: DocumentRow[] = [...(seed.documents ?? [])]
  const events: string[] = []

  const api = {
    async $transaction<T>(fn: (tx: unknown) => Promise<T>) {
      const snap = { attachments: attachments.map((a) => ({ ...a })), documents: [...documents] }
      events.push("begin")
      try {
        const out = await fn(api)
        events.push("commit")
        return out
      } catch (error) {
        attachments = snap.attachments
        documents = snap.documents
        events.push("rollback")
        throw error
      }
    },
    async $executeRaw(strings: TemplateStringsArray) {
      events.push(`exec:${strings.join("?").trim()}`)
      return 0
    },
    async $queryRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
      if (seed.failOn === "lock") throw new Error("lock_timeout")
      events.push("lock-draft")
      const [messageId, companyId] = values as [string, string]
      return (seed.drafts ?? [])
        .filter((d) => d.acquisitionMessageId === messageId && d.companyId === companyId)
        .map((d) => ({ id: d.id, status: d.status, createdWorksiteId: d.createdWorksiteId }))
    },
    acquisitionAttachment: {
      async findFirst({ where, include }: { where: { id: string; companyId: string }; include?: unknown }) {
        const row = attachments.find((a) => a.id === where.id && a.companyId === where.companyId)
        if (!row) return null
        return include
          ? {
              ...row,
              acquisitionMessage: {
                id: row.acquisitionMessageId,
                companyId: row.companyId,
                externalMessageId: "ext-msg",
                sourceMailboxKey: "conn-1",
              },
            }
          : row
      },
      async findFirstOrThrow({ where }: { where: { id: string; companyId: string } }) {
        const row = attachments.find((a) => a.id === where.id && a.companyId === where.companyId)
        if (!row) throw new Error("not found")
        events.push("read-row")
        return row
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; companyId: string; status: string }
        data: Partial<AttachmentRow>
      }) {
        const row = attachments.find(
          (a) => a.id === where.id && a.companyId === where.companyId && a.status === where.status
        )
        if (!row) return { count: 0 }
        Object.assign(row, data)
        events.push("update-stored")
        return { count: 1 }
      },
    },
    worksite: {
      async findFirst({ where }: { where: { id: string; companyId: string } }) {
        return (seed.worksites ?? []).find((w) => w.id === where.id && w.companyId === where.companyId) ?? null
      },
    },
    document: {
      async createMany({ data }: { data: Array<{ sourceAcquisitionAttachmentId: string; worksiteId: string; type: string }> }) {
        if (seed.failOn === "document") throw new Error("db down")
        let count = 0
        for (const row of data) {
          if (!documents.some((d) => d.sourceAcquisitionAttachmentId === row.sourceAcquisitionAttachmentId)) {
            documents.push({
              sourceAcquisitionAttachmentId: row.sourceAcquisitionAttachmentId,
              worksiteId: row.worksiteId,
              type: row.type,
            })
            count++
          }
        }
        events.push("create-document")
        return { count }
      },
    },
  }

  return {
    db: api as unknown as PrismaClient,
    events,
    get documents() {
      return documents
    },
    get attachments() {
      return attachments
    },
  }
}

const convertedDraft: DraftRow = {
  id: "d-1",
  status: "CONVERTED",
  createdWorksiteId: "ws-1",
  acquisitionMessageId: "msg-1",
  companyId: "co-1",
}

describe("AcquisitionAttachmentRepository.markStored — protocole v2", () => {
  it("brouillon CONVERTED : verrou → STORED → Document, dans UNE transaction (ordre B)", async () => {
    const h = makeDb({
      attachments: [pendingAttachment()],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-1" }],
    })
    const repo = new AcquisitionAttachmentRepository(h.db, () => {})
    const r = await repo.markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "STORED")
    assert.deepEqual(h.documents, [{ sourceAcquisitionAttachmentId: "att-1", worksiteId: "ws-1", type: "PLAN" }])
    assert.deepEqual(h.events, [
      "begin",
      "exec:SET LOCAL lock_timeout = '4s'",
      "lock-draft",
      "update-stored",
      "read-row",
      "create-document",
      "commit",
    ])
  })

  it("brouillon pas encore converti : STORED sans Document (ordre A, la conversion copiera)", async () => {
    const h = makeDb({
      attachments: [pendingAttachment()],
      drafts: [{ ...convertedDraft, status: "APPROVED", createdWorksiteId: null }],
    })
    const r = await new AcquisitionAttachmentRepository(h.db, () => {}).markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "STORED")
    assert.equal(h.documents.length, 0)
    assert.ok(h.events.indexOf("lock-draft") < h.events.indexOf("update-stored"))
  })

  it("aucun brouillon pour ce message : STORED normal, sans Document", async () => {
    const h = makeDb({ attachments: [pendingAttachment()] })
    const r = await new AcquisitionAttachmentRepository(h.db, () => {}).markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "STORED")
    assert.equal(h.documents.length, 0)
  })

  it("échec du pont : transaction annulée, pièce NON STORED, résultat FAILED (retry existant)", async () => {
    const logs: string[] = []
    const h = makeDb({
      attachments: [pendingAttachment()],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-1" }],
      failOn: "document",
    })
    const r = await new AcquisitionAttachmentRepository(h.db, (e) => {
      logs.push(e)
    }).markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "FAILED")
    assert.equal(h.attachments[0]!.status, "PENDING_DOWNLOAD")
    assert.equal(h.attachments[0]!.storagePublicId, null)
    assert.equal(h.documents.length, 0)
    assert.ok(h.events.includes("rollback"))
    assert.deepEqual(logs, ["MARK_STORED_ROLLED_BACK"])
  })

  it("journal défaillant : markStored renvoie quand même FAILED (compensation et retry préservés)", async () => {
    const h = makeDb({
      attachments: [pendingAttachment()],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-1" }],
      failOn: "document",
    })
    const repo = new AcquisitionAttachmentRepository(h.db, () => {
      throw new Error("log down")
    })
    const r = await repo.markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "FAILED")
    assert.equal(h.attachments[0]!.status, "PENDING_DOWNLOAD")
  })

  it("délai de verrou dépassé : rien n'est modifié, résultat FAILED", async () => {
    const h = makeDb({
      attachments: [pendingAttachment()],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-1" }],
      failOn: "lock",
    })
    const r = await new AcquisitionAttachmentRepository(h.db, () => {}).markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "FAILED")
    assert.equal(h.attachments[0]!.status, "PENDING_DOWNLOAD")
    assert.ok(!h.events.includes("update-stored"))
  })

  it("jamais de résurrection : pièce déjà STORED + Document supprimé → ALREADY_STORED, aucun Document recréé", async () => {
    const stored = pendingAttachment({
      status: "STORED",
      sha256: "b".repeat(64),
      storagePublicId: "acq/co-1/plan",
      storedAt: new Date("2026-10-31T09:00:00Z"),
    })
    const h = makeDb({
      attachments: [stored],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-1" }],
      documents: [], // l'utilisateur a supprimé le Document
    })
    const r = await new AcquisitionAttachmentRepository(h.db, () => {}).markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "ALREADY_STORED")
    assert.equal(h.documents.length, 0)
    assert.ok(!h.events.includes("create-document"))
  })

  it("tenant : autre companyId → rien (ni transition, ni Document)", async () => {
    const h = makeDb({
      attachments: [pendingAttachment()],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-1" }],
    })
    const r = await new AcquisitionAttachmentRepository(h.db, () => {}).markStored("co-2", "att-1", STORED_UPDATE)
    assert.equal(r.status, "FAILED")
    assert.equal(h.attachments[0]!.status, "PENDING_DOWNLOAD")
    assert.equal(h.documents.length, 0)
  })

  it("chantier d'un autre tenant ou supprimé : STORED sans Document", async () => {
    const h = makeDb({
      attachments: [pendingAttachment()],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-other" }],
    })
    const r = await new AcquisitionAttachmentRepository(h.db, () => {}).markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(r.status, "STORED")
    assert.equal(h.documents.length, 0)
  })

  it("pièce PHOTO → Document de type PHOTO", async () => {
    const h = makeDb({
      attachments: [pendingAttachment({ category: "PHOTO", filename: "a.jpg" })],
      drafts: [convertedDraft],
      worksites: [{ id: "ws-1", companyId: "co-1" }],
    })
    await new AcquisitionAttachmentRepository(h.db, () => {}).markStored("co-1", "att-1", STORED_UPDATE)
    assert.equal(h.documents[0]?.type, "PHOTO")
  })
})
