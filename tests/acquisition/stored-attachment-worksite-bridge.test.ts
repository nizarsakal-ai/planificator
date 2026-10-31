process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { Prisma } from "@prisma/client"
import {
  bridgeStoredAttachmentInTransaction,
  lockDraftByIdForUpdate,
  lockDraftByMessageForUpdate,
  type BridgeableAttachment,
  type LockedDraft,
} from "@/lib/acquisition/conversion/stored-attachment-worksite-bridge.service"

type DocumentRow = {
  worksiteId: string
  name: string
  url: string | null
  size: number
  mimeType: string
  type: string
  storagePublicId: string
  sourceAcquisitionAttachmentId: string
}

function makeTx(seed: {
  worksites: Array<{ id: string; companyId: string }>
  documents?: DocumentRow[]
  draftRows?: LockedDraft[]
}) {
  const documents: DocumentRow[] = [...(seed.documents ?? [])]
  const sql: Array<{ text: string; values: unknown[] }> = []
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push({ text: strings.join("?"), values })
      return seed.draftRows ?? []
    },
    worksite: {
      findFirst: async ({ where }: { where: { id: string; companyId: string } }) =>
        seed.worksites.find((w) => w.id === where.id && w.companyId === where.companyId) ?? null,
    },
    document: {
      createMany: async ({ data }: { data: DocumentRow[]; skipDuplicates: boolean }) => {
        let count = 0
        for (const row of data) {
          if (!documents.some((d) => d.sourceAcquisitionAttachmentId === row.sourceAcquisitionAttachmentId)) {
            documents.push(row)
            count++
          }
        }
        return { count }
      },
    },
  } as unknown as Prisma.TransactionClient
  return { tx, documents, sql }
}

const attachment: BridgeableAttachment = {
  id: "att-1",
  filename: "plan.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  category: "PLAN",
  storagePublicId: "acq/co-1/plan",
}

const convertedDraft: LockedDraft = { id: "d-1", status: "CONVERTED", createdWorksiteId: "ws-1" }

describe("verrous de brouillon", () => {
  it("lockDraftByIdForUpdate : SELECT … FOR UPDATE scopé tenant sur worksite_import_drafts", async () => {
    const { tx, sql } = makeTx({ worksites: [] })
    await lockDraftByIdForUpdate(tx, { companyId: "co-1", draftId: "d-1" })
    assert.equal(sql.length, 1)
    assert.match(sql[0]!.text, /FROM "worksite_import_drafts"/)
    assert.match(sql[0]!.text, /"companyId"/)
    assert.match(sql[0]!.text, /FOR UPDATE/)
    assert.deepEqual(sql[0]!.values, ["d-1", "co-1"])
  })

  it("lockDraftByMessageForUpdate : scopé tenant, renvoie la ligne ou null", async () => {
    const withRow = makeTx({ worksites: [], draftRows: [convertedDraft] })
    const row = await lockDraftByMessageForUpdate(withRow.tx, {
      companyId: "co-1",
      acquisitionMessageId: "msg-1",
    })
    assert.deepEqual(row, convertedDraft)
    assert.match(withRow.sql[0]!.text, /"acquisitionMessageId"/)
    assert.match(withRow.sql[0]!.text, /"companyId"/)
    assert.match(withRow.sql[0]!.text, /FOR UPDATE/)
    assert.deepEqual(withRow.sql[0]!.values, ["msg-1", "co-1"])

    const empty = makeTx({ worksites: [] })
    assert.equal(
      await lockDraftByMessageForUpdate(empty.tx, { companyId: "co-1", acquisitionMessageId: "msg-x" }),
      null
    )
  })
})

describe("bridgeStoredAttachmentInTransaction", () => {
  it("brouillon CONVERTED : crée un Document PLAN sans URL ni re-upload", async () => {
    const { tx, documents } = makeTx({ worksites: [{ id: "ws-1", companyId: "co-1" }] })
    const outcome = await bridgeStoredAttachmentInTransaction(tx, {
      companyId: "co-1",
      draft: convertedDraft,
      attachment,
    })
    assert.equal(outcome, "CREATED")
    assert.deepEqual(documents, [
      {
        worksiteId: "ws-1",
        name: "plan.pdf",
        url: null,
        size: 2048,
        mimeType: "application/pdf",
        type: "PLAN",
        storagePublicId: "acq/co-1/plan",
        sourceAcquisitionAttachmentId: "att-1",
      },
    ])
  })

  it("mappe PHOTO → PHOTO, autre → DOCUMENT", async () => {
    const { tx, documents } = makeTx({ worksites: [{ id: "ws-1", companyId: "co-1" }] })
    await bridgeStoredAttachmentInTransaction(tx, {
      companyId: "co-1",
      draft: convertedDraft,
      attachment: { ...attachment, id: "att-2", category: "PHOTO" },
    })
    await bridgeStoredAttachmentInTransaction(tx, {
      companyId: "co-1",
      draft: convertedDraft,
      attachment: { ...attachment, id: "att-3", category: "UNKNOWN" },
    })
    assert.deepEqual(
      documents.map((d) => d.type),
      ["PHOTO", "DOCUMENT"]
    )
  })

  it("idempotent : second appel → ALREADY_BRIDGED, aucun doublon", async () => {
    const { tx, documents } = makeTx({ worksites: [{ id: "ws-1", companyId: "co-1" }] })
    const input = { companyId: "co-1", draft: convertedDraft, attachment }
    assert.equal(await bridgeStoredAttachmentInTransaction(tx, input), "CREATED")
    assert.equal(await bridgeStoredAttachmentInTransaction(tx, input), "ALREADY_BRIDGED")
    assert.equal(documents.length, 1)
  })

  it("pas de brouillon, brouillon non converti ou sans chantier → rien", async () => {
    const { tx, documents } = makeTx({ worksites: [{ id: "ws-1", companyId: "co-1" }] })
    for (const draft of [
      null,
      { ...convertedDraft, status: "APPROVED" },
      { ...convertedDraft, createdWorksiteId: null },
    ] as Array<LockedDraft | null>) {
      assert.equal(
        await bridgeStoredAttachmentInTransaction(tx, { companyId: "co-1", draft, attachment }),
        "NO_CONVERTED_WORKSITE"
      )
    }
    assert.equal(documents.length, 0)
  })

  it("chantier d'un autre tenant ou supprimé → rien", async () => {
    const { tx, documents } = makeTx({ worksites: [{ id: "ws-1", companyId: "co-other" }] })
    assert.equal(
      await bridgeStoredAttachmentInTransaction(tx, {
        companyId: "co-1",
        draft: convertedDraft,
        attachment,
      }),
      "NO_CONVERTED_WORKSITE"
    )
    assert.equal(documents.length, 0)
  })
})
