/**
 * PLAN-ACQ-MULTIMODAL — Relance manuelle autonome : contenu + pièces manquants.
 * Gmail / Cloudinary / DB : mocks injectés uniquement.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  ATTACHMENT_DOWNLOAD_DISABLED_WARNING,
  CONTENT_FETCH_DISABLED_WARNING,
  MANUAL_REEXTRACT_MAX_DOWNLOADS,
  prepareManualReExtraction,
  type ManualReExtractAttachmentRow,
  type ManualReExtractPreparationDeps,
} from "@/lib/acquisition/extraction/manual-reextract-preparation"
import { reExtractImportDraftActionImpl } from "@/lib/actions/acquisition-review.actions.core"
import { runDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import type { PersistExtractionInput } from "@/lib/acquisition/extraction/extraction.repository"
import { buildFlateCompressedMultiBlockPdf } from "@/lib/acquisition/extraction/pdf-text-extract"

function deps(over: Partial<ManualReExtractPreparationDeps> & {
  content?: { normalizedText: string } | null
  attachments?: ManualReExtractAttachmentRow[]
} = {}) {
  const calls = { fetch: 0, downloads: [] as string[], schedules: [] as string[] }
  const d: ManualReExtractPreparationDeps = {
    isAcquisitionEnabled: () => true,
    isContentFetchEnabled: () => true,
    isAttachmentDownloadEnabled: () => true,
    findDraftMessageId: async (companyId, draftId) => (companyId === "co1" && draftId === "d1" ? "m1" : null),
    findContent: async () => (over.content === undefined ? null : over.content),
    fetchContent: async () => {
      calls.fetch++
      return {
        ok: true,
        outcome: "FETCHED",
        idempotent: false,
        content: {} as never,
      } as never
    },
    listAttachments: async () => over.attachments ?? [],
    scheduleRetryToDiscovered: async (i) => {
      calls.schedules.push(i.attachmentId)
      assert.deepEqual(i.retryableErrorCodes, ["GMAIL_NOT_CONNECTED", "ATTACHMENT_STORAGE_FAILED"])
      return "TRANSITIONED"
    },
    downloadAttachment: async (i) => {
      calls.downloads.push(i.attachmentId)
      assert.equal(i.companyId, "co1")
      return { outcome: "STORED", attachmentId: i.attachmentId }
    },
    log: () => {},
    ...over,
  }
  return { d, calls }
}

const A = (id: string, status: string, lastErrorCode: string | null = null): ManualReExtractAttachmentRow => ({
  id,
  filename: `${id}.pdf`,
  status,
  lastErrorCode,
})

describe("prepareManualReExtraction", () => {
  it("flags ON : texte manquant → fetch ; DISCOVERED + FAILED retryable → téléchargés ; autres ignorés", async () => {
    const { d, calls } = deps({
      content: null,
      attachments: [
        A("a1", "DISCOVERED"),
        A("a2", "FAILED", "ATTACHMENT_STORAGE_FAILED"),
        A("a3", "FAILED", "ATTACHMENT_SIGNATURE_MISMATCH"),
        A("a4", "REJECTED", "ATTACHMENT_MIME_NOT_ALLOWED"),
        A("a5", "STORED"),
        A("a6", "PENDING_DOWNLOAD"),
      ],
    })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1", actorUserId: "u1" }, d)
    assert.equal(calls.fetch, 1)
    assert.deepEqual(calls.schedules, ["a2"])
    assert.deepEqual(calls.downloads, ["a1", "a2"])
    assert.deepEqual(r, { warnings: [], contentFetched: true, attachmentsStored: 2 })
  })

  it("texte déjà présent → pas de fetch", async () => {
    const { d, calls } = deps({ content: { normalizedText: "Bonjour" } })
    await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.equal(calls.fetch, 0)
  })

  it("flag content fetch OFF → message clair, aucun accès DB / Gmail", async () => {
    let touched = false
    const { d, calls } = deps({
      isContentFetchEnabled: () => false,
      findDraftMessageId: async () => {
        touched = true
        return "m1"
      },
    })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.deepEqual(r.warnings, [CONTENT_FETCH_DISABLED_WARNING])
    assert.equal(touched, false)
    assert.equal(calls.fetch, 0)
  })

  it("flag download OFF → message clair, aucun téléchargement", async () => {
    const { d, calls } = deps({
      content: { normalizedText: "x" },
      isAttachmentDownloadEnabled: () => false,
      attachments: [A("a1", "DISCOVERED"), A("a2", "FAILED", "GMAIL_NOT_CONNECTED")],
    })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.deepEqual(r.warnings, [`${ATTACHMENT_DOWNLOAD_DISABLED_WARNING} : 2 pièce(s) non récupérée(s)`])
    assert.deepEqual(calls.downloads, [])
    assert.deepEqual(calls.schedules, [])
  })

  it("master OFF → rien", async () => {
    const { d, calls } = deps({ isAcquisitionEnabled: () => false, content: null, attachments: [A("a1", "DISCOVERED")] })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.deepEqual(r.warnings, [])
    assert.equal(calls.fetch, 0)
    assert.deepEqual(calls.downloads, [])
  })

  it("échecs non bloquants → avertissements (mail vide, Gmail KO, pièce refusée, exception)", async () => {
    const { d } = deps({
      content: null,
      attachments: [A("a1", "DISCOVERED"), A("a2", "DISCOVERED"), A("a3", "DISCOVERED")],
      fetchContent: async () =>
        ({ ok: false, outcome: "EMPTY_CONTENT", code: "CONTENT_EMPTY", message: "Aucun contenu textuel exploitable" }) as never,
      downloadAttachment: async (i) => {
        if (i.attachmentId === "a1") return { outcome: "REJECTED", attachmentId: "a1", errorCode: "ATTACHMENT_MIME_NOT_ALLOWED" }
        if (i.attachmentId === "a2") throw new Error("boom secret token")
        return { outcome: "STORED", attachmentId: "a3" }
      },
    })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.equal(r.attachmentsStored, 1)
    assert.deepEqual(r.warnings, [
      "Le mail ne contient pas de texte exploitable : extraction sur les pièces jointes",
      "Pièce « a1.pdf » non récupérée (ATTACHMENT_MIME_NOT_ALLOWED)",
      "Pièce « a2.pdf » non récupérée (erreur inattendue)",
    ])
    assert.ok(!JSON.stringify(r).includes("secret"))

    const gmailKo = deps({
      content: null,
      fetchContent: async () =>
        ({ ok: false, outcome: "FAILED", code: "GMAIL_NOT_CONNECTED", message: "Boîte Gmail non connectée" }) as never,
    })
    const r2 = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, gmailKo.d)
    assert.deepEqual(r2.warnings, ["Contenu du mail non récupéré : Boîte Gmail non connectée"])
  })

  it("FAILED retryable non échu (backoff) → pas de contournement, avertissement", async () => {
    const { d, calls } = deps({
      content: { normalizedText: "x" },
      attachments: [A("a1", "FAILED", "GMAIL_NOT_CONNECTED")],
      scheduleRetryToDiscovered: async () => "NOOP",
    })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.deepEqual(calls.downloads, [])
    assert.deepEqual(r.warnings, ["Pièce « a1.pdf » : nouvel essai prévu plus tard"])
  })

  it("bornes : 10 téléchargements max puis relais du cron", async () => {
    const atts = Array.from({ length: 13 }, (_, i) => A(`a${i}`, "DISCOVERED"))
    const { d, calls } = deps({ content: { normalizedText: "x" }, attachments: atts })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.equal(calls.downloads.length, MANUAL_REEXTRACT_MAX_DOWNLOADS)
    assert.deepEqual(r.warnings, ["3 pièce(s) restante(s) seront récupérées par la tâche planifiée"])
  })

  it("budget temps dépassé → arrêt propre", async () => {
    let t = 0
    const { d, calls } = deps({
      content: { normalizedText: "x" },
      attachments: [A("a1", "DISCOVERED"), A("a2", "DISCOVERED")],
      clock: () => t,
      downloadAttachment: async (i) => {
        t += 25_000
        calls.downloads.push(i.attachmentId)
        return { outcome: "STORED", attachmentId: i.attachmentId }
      },
    })
    const r = await prepareManualReExtraction({ companyId: "co1", draftId: "d1" }, d)
    assert.deepEqual(calls.downloads, ["a1"])
    assert.deepEqual(r.warnings, ["1 pièce(s) restante(s) seront récupérées par la tâche planifiée"])
  })

  it("draft d'un autre tenant → rien", async () => {
    const { d, calls } = deps({ content: null, attachments: [A("a1", "DISCOVERED")] })
    await prepareManualReExtraction({ companyId: "co2", draftId: "d1" }, d)
    assert.equal(calls.fetch, 0)
    assert.deepEqual(calls.downloads, [])
  })
})

describe("reExtractImportDraftActionImpl — relance autonome", () => {
  const base = {
    auth: async () => ({ user: { id: "u1", role: "ADMIN" as const, companyId: "co1" } }),
    isAcquisitionEnabled: () => true,
    isAcquisitionExtractionEnabled: () => true,
    getImportDraftStatusForReview: async () => ({ id: "d1", status: "FAILED" as const, version: 3 }),
    revalidatePath: () => {},
  }

  it("prépare (companyId session) AVANT l'extraction et renvoie les avertissements", async () => {
    const order: string[] = []
    const r = await reExtractImportDraftActionImpl(
      { draftId: "d1" },
      {
        ...base,
        prepareManualReExtraction: async (input) => {
          order.push(`prepare:${input.companyId}:${input.draftId}:${input.actorUserId}`)
          return { warnings: ["Téléchargement des pièces jointes désactivé (flag) : 1 pièce(s) non récupérée(s)"], contentFetched: false, attachmentsStored: 0 }
        },
        runDraftExtraction: async () => {
          order.push("extract")
          return { ok: true, outcome: "EXTRACTED", draftId: "d1", status: "PENDING_REVIEW", contentHashAtExtraction: "h", warningCount: 0 }
        },
      }
    )
    assert.deepEqual(order, ["prepare:co1:d1:u1", "extract"])
    assert.equal(r.ok, true)
    assert.deepEqual(r.warnings, ["Téléchargement des pièces jointes désactivé (flag) : 1 pièce(s) non récupérée(s)"])
  })

  it("préparation en erreur → extraction quand même, avertissement générique", async () => {
    let extracted = false
    const r = await reExtractImportDraftActionImpl(
      { draftId: "d1" },
      {
        ...base,
        prepareManualReExtraction: async () => {
          throw new Error("db down")
        },
        runDraftExtraction: async () => {
          extracted = true
          return { ok: false, outcome: "CONTENT_MISSING", code: "CONTENT_MISSING", message: "Contenu message absent et aucune pièce jointe lisible (005A)", draftId: "d1" }
        },
      }
    )
    assert.equal(extracted, true)
    assert.equal(r.ok, false)
    assert.deepEqual(r.warnings, ["Récupération des sources impossible : extraction avec les données disponibles"])
  })

  it("statut non relançable → aucune préparation", async () => {
    let prepared = false
    const r = await reExtractImportDraftActionImpl(
      { draftId: "d1" },
      {
        ...base,
        getImportDraftStatusForReview: async () => ({ id: "d1", status: "CONVERTED" as const, version: 3 }),
        prepareManualReExtraction: async () => {
          prepared = true
          return { warnings: [], contentFetched: false, attachmentsStored: 0 }
        },
      }
    )
    assert.equal(r.ok, false)
    assert.equal(prepared, false)
  })
})

describe("bout en bout (mocks) : relance → pièce téléchargée → extraction PJ seules", () => {
  it("flags ON : le bon de commande DISCOVERED est récupéré puis lu, la consultation passe en revue", async () => {
    const keys = ["PLANIFICATOR_ACQUISITION_ENABLED", "ACQUISITION_CONTENT_FETCH_ENABLED", "ACQUISITION_EXTRACTION_ENABLED", "ACQUISITION_EXTRACTION_PROVIDER"] as const
    const backup = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    try {
      const att = {
        id: "a1",
        sha256: null as string | null,
        filename: "BC-ACME.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        sizeBytes: 900,
        status: "DISCOVERED",
        storagePublicId: null as string | null,
      }
      let draft = {
        id: "d1", companyId: "co1", acquisitionMessageId: "m1", status: "FAILED" as string, version: 1,
        extractionAttemptCount: 1, extractionStartedAt: null as Date | null, contentHashAtExtraction: null as string | null,
        extractionSchemaVersion: null, detectionClassification: null, detectionContentHash: null, extractionRetryable: false,
      }
      const persists: PersistExtractionInput[] = []
      const repo = {
        findDraft: async () => ({ ...draft }),
        findContent: async () => null,
        findMessage: async () => ({ id: "m1", subject: "Commande", receivedAt: new Date() }),
        listAttachmentMetadata: async () => [{ ...att }],
        claimExtracting: async () => {
          draft = { ...draft, status: "EXTRACTING", version: draft.version + 1, extractionAttemptCount: draft.extractionAttemptCount + 1 }
          return { ...draft }
        },
        persistExtraction: async (input: PersistExtractionInput) => {
          persists.push(input)
          draft = { ...draft, status: input.status, version: draft.version + 1, contentHashAtExtraction: input.expectedContentHash }
          return "OK" as const
        },
        markFailedWhileExtracting: async () => "OK" as const,
      }
      const r = await reExtractImportDraftActionImpl(
        { draftId: "d1" },
        {
          auth: async () => ({ user: { id: "u1", role: "ADMIN" as const, companyId: "co1" } }),
          getImportDraftStatusForReview: async () => ({ id: "d1", status: "FAILED" as const, version: 1 }),
          revalidatePath: () => {},
          prepareManualReExtraction: (input) =>
            prepareManualReExtraction(input, {
              isAttachmentDownloadEnabled: () => true,
              findDraftMessageId: async () => "m1",
              findContent: async () => null,
              fetchContent: async () =>
                ({ ok: false, outcome: "EMPTY_CONTENT", code: "CONTENT_EMPTY", message: "x" }) as never,
              listAttachments: async () => [{ id: att.id, filename: att.filename, status: att.status, lastErrorCode: null }],
              downloadAttachment: async () => {
                att.status = "STORED"
                att.storagePublicId = "acq/co1/a1"
                att.sha256 = "abc"
                return { outcome: "STORED", attachmentId: "a1" }
              },
              log: () => {},
            }),
          runDraftExtraction: (input) =>
            runDraftExtraction(input, {
              repository: repo as never,
              loadAttachmentBytes: async () => buildFlateCompressedMultiBlockPdf(["Chantier : Residence Les Lilas", "Reference : CMD-2026-114"]),
            }),
        }
      )
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.deepEqual(r.warnings, ["Le mail ne contient pas de texte exploitable : extraction sur les pièces jointes"])
      assert.equal(persists[0].sourceKind, "ATTACHMENTS_ONLY")
      assert.ok(persists[0].expectedContentHash.startsWith("att1:"))
    } finally {
      for (const k of keys) {
        if (backup[k] === undefined) delete process.env[k]
        else process.env[k] = backup[k]
      }
    }
  })
})
