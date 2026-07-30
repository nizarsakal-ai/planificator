/**
 * PLAN-ACQ-V2 R3 — Tests maybeRunAutoDecisionAfterExtraction (service réel + deps mockées).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { maybeRunAutoDecisionAfterExtraction } from "@/lib/acquisition/policy/auto-decision.service"
import type { AcquisitionPartnerRecord } from "@/lib/acquisition/persistence/partner-registry.repository"
import type { PartnerRegistryRepositoryPort } from "@/lib/acquisition/persistence/partner-registry.repository"
import type { DecisionJournalEntry } from "@/lib/acquisition/policy/decision-journal.repository"

type DraftRow = {
  id: string
  companyId: string
  status: string
  version: number
  proposedWorksiteName: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  proposedStartDate: Date | null
  proposedEndDate: Date | null
  proposedContactEmail: string | null
  proposedClientId: string | null
  confidenceData: Record<string, number>
  warningData: unknown[]
  extractedData: unknown
  acquisitionMessage: { resolvedPartnerId: string | null; senderDomain: string | null }
}

function partner(over: Partial<AcquisitionPartnerRecord> = {}): AcquisitionPartnerRecord {
  return {
    id: "p1",
    companyId: "co1",
    name: "Partner",
    code: "partner",
    connector: "GMAIL",
    pipeline: "consultations",
    active: true,
    priority: 100,
    requireExactEmail: false,
    autoApproveEnabled: true,
    autoConvertEnabled: true,
    allowCreateClient: false,
    minConfidence: 0.75,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

function baseDraft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: "d1",
    companyId: "co1",
    status: "PENDING_REVIEW",
    version: 1,
    proposedWorksiteName: "Site Alpha",
    proposedClientName: "Client SA",
    proposedAddress: "10 rue Test",
    proposedPostalCode: "75001",
    proposedCity: "Paris",
    proposedStartDate: new Date("2026-08-01"),
    proposedEndDate: new Date("2026-08-05"),
    proposedContactEmail: "c@example.com",
    proposedClientId: "c1",
    confidenceData: {
      worksiteName: 0.95,
      requestedStartDate: 0.95,
      requestedEndDate: 0.95,
    },
    warningData: [],
    extractedData: {},
    acquisitionMessage: { resolvedPartnerId: "p1", senderDomain: "partner.fr" },
    ...over,
  }
}

function emptyRegistry(
  p: AcquisitionPartnerRecord | null,
  opts?: { domainFallback?: AcquisitionPartnerRecord | null }
): PartnerRegistryRepositoryPort {
  const byDomain = opts?.domainFallback ?? null
  return {
    findPartnerByCode: async () => null,
    findPartnerById: async () => p,
    findPartnerByDomain: async (companyId, domain) => {
      if (!byDomain) return null
      if (byDomain.companyId !== companyId) return null
      return {
        ...byDomain,
        domain: {
          id: "dom1",
          companyId,
          partnerId: byDomain.id,
          domainNormalized: domain.trim().toLowerCase(),
          active: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }
    },
    findPartnerByEmail: async () => null,
    findDomain: async () => null,
    listPartners: async () => (p ? [p] : []),
    listDomains: async () => [],
    listEmails: async () => [],
    partnerExists: async () => false,
    domainExists: async () => false,
  }
}

describe("maybeRunAutoDecisionAfterExtraction R3", () => {
  const env = { ...process.env }
  let journalEntries: DecisionJournalEntry[]
  let approveCalls: number
  let convertCalls: number
  let draft: DraftRow

  beforeEach(() => {
    process.env = { ...env }
    process.env.ACQUISITION_AUTO_APPROVE_ENABLED = "true"
    process.env.ACQUISITION_AUTO_CONVERT_ENABLED = "true"
    process.env.ACQUISITION_SYSTEM_ACTOR_USER_ID = "sys1"
    journalEntries = []
    approveCalls = 0
    convertCalls = 0
    draft = baseDraft()
  })

  afterEach(() => {
    process.env = { ...env }
  })

  function deps(opts: {
    partner?: AcquisitionPartnerRecord | null
    /** Partenaire résolu uniquement via findPartnerByDomain (resolvedPartnerId null). */
    domainFallbackPartner?: AcquisitionPartnerRecord | null
    duplicate?: boolean
    clientAmbiguous?: boolean
    systemOk?: boolean
  }) {
    const p = opts.partner === undefined ? partner() : opts.partner
    return {
      db: {
        worksiteImportDraft: {
          findFirst: async () => draft,
        },
      } as never,
      journal: {
        append: async (e: DecisionJournalEntry) => {
          journalEntries.push(e)
        },
      } as never,
      review: {
        approveImportDraft: async () => {
          approveCalls++
          draft = { ...draft, status: "APPROVED", version: draft.version + 1 }
          return { ok: true, outcome: "APPROVED", version: draft.version }
        },
      } as never,
      conversion: {
        convertImportDraft: async () => {
          convertCalls++
          draft = { ...draft, status: "CONVERTED" }
          return { ok: true, outcome: "CONVERTED" }
        },
      } as never,
      registry: emptyRegistry(p, {
        domainFallback: opts.domainFallbackPartner ?? null,
      }),
      resolveSystemActor: async () =>
        opts.systemOk === false
          ? ({ ok: false, code: "SYSTEM_ACTOR_INVALID", reason: "user_inactive" } as const)
          : ({ ok: true, userId: "sys1", role: "ADMIN" } as const),
      findDuplicate: async () =>
        opts.duplicate
          ? { worksiteId: "ws-dup", matchKind: "ADDRESS" as const }
          : { worksiteId: null, matchKind: "NONE" as const },
      matchClient: async () =>
        opts.clientAmbiguous
          ? { clientId: null, matchKind: "NAME" as const, ambiguous: true }
          : { clientId: "c1", matchKind: "PROPOSED_ID" as const, ambiguous: false },
      log: () => {},
    }
  }

  it("partenaire auto OFF → journal HUMAN_REVIEW, aucune mutation", async () => {
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({ partner: partner({ autoApproveEnabled: false }) }),
    })
    assert.equal(approveCalls, 0)
    assert.equal(convertCalls, 0)
    assert.equal(draft.status, "PENDING_REVIEW")
    assert.ok(journalEntries.some((j) => j.decisionCode === "HUMAN_REVIEW_REQUIRED"))
    assert.ok(
      journalEntries.some((j) => j.reasons.includes("AUTO_APPROVE_DISABLED"))
    )
  })

  it("confiance sous seuil → pas de mutation", async () => {
    draft = baseDraft({
      confidenceData: {
        worksiteName: 0.1,
        requestedStartDate: 0.1,
        requestedEndDate: 0.1,
      },
    })
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({}),
    })
    assert.equal(approveCalls, 0)
    assert.equal(convertCalls, 0)
    assert.ok(
      journalEntries.some((j) =>
        j.reasons.some((r) => r.startsWith("LOW_CONFIDENCE"))
      )
    )
  })

  it("client ambigu → pas de mutation", async () => {
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({ clientAmbiguous: true }),
    })
    assert.equal(approveCalls, 0)
    assert.ok(journalEntries.some((j) => j.reasons.includes("AMBIGUOUS_CLIENT")))
  })

  it("adresse ambiguë → pas de mutation", async () => {
    draft = baseDraft({ proposedCity: null })
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({}),
    })
    assert.equal(approveCalls, 0)
    assert.ok(journalEntries.some((j) => j.reasons.includes("AMBIGUOUS_ADDRESS")))
  })

  it("prompt injection → pas de mutation", async () => {
    draft = baseDraft({
      warningData: [{ code: "POTENTIAL_PROMPT_INJECTION", blocking: false }],
    })
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({}),
    })
    assert.equal(approveCalls, 0)
    assert.ok(journalEntries.some((j) => j.reasons.includes("PROMPT_INJECTION_RISK")))
  })

  it("doublon → pas de mutation", async () => {
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({ duplicate: true }),
    })
    assert.equal(approveCalls, 0)
    assert.equal(convertCalls, 0)
    assert.ok(journalEntries.some((j) => j.reasons.includes("POTENTIAL_DUPLICATE")))
  })

  it("document requis illisible → pas de mutation", async () => {
    draft = baseDraft({
      warningData: [{ code: "REQUIRED_DOCUMENT_UNREADABLE", field: "PLAN" }],
    })
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({}),
    })
    assert.equal(approveCalls, 0)
    assert.ok(
      journalEntries.some((j) => j.reasons.includes("REQUIRED_DOCUMENT_UNREADABLE"))
    )
  })

  it("SYSTEM invalide → pas de mutation + journal SYSTEM_ACTOR_INVALID", async () => {
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({ systemOk: false }),
    })
    assert.equal(approveCalls, 0)
    assert.equal(convertCalls, 0)
    // décision positive journalisée puis blocage acteur
    assert.ok(journalEntries.some((j) => j.decisionCode === "AUTO_APPROVE_CONVERT"))
    assert.ok(journalEntries.some((j) => j.decisionCode === "SYSTEM_ACTOR_INVALID"))
  })

  it("cas valide → approve puis convert", async () => {
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({}),
    })
    assert.equal(approveCalls, 1)
    assert.equal(convertCalls, 1)
    assert.equal(draft.status, "CONVERTED")
    assert.ok(journalEntries.some((j) => j.decisionCode === "AUTO_APPROVE_CONVERT"))
  })

  it("PR34-M3: resolvedPartnerId null + requireExactEmail=true → aucune auto", async () => {
    draft = baseDraft({
      acquisitionMessage: { resolvedPartnerId: null, senderDomain: "partner.fr" },
    })
    const exactPartner = partner({
      requireExactEmail: true,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
    })
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({
        partner: null,
        domainFallbackPartner: exactPartner,
      }),
    })
    assert.equal(approveCalls, 0)
    assert.equal(convertCalls, 0)
    assert.equal(draft.status, "PENDING_REVIEW")
    assert.ok(journalEntries.some((j) => j.decisionCode === "HUMAN_REVIEW_REQUIRED"))
    assert.ok(
      journalEntries.some((j) => j.reasons.includes("AUTO_APPROVE_DISABLED"))
    )
  })

  it("PR34-M3: resolvedPartnerId null + requireExactEmail=false → fallback domaine OK", async () => {
    draft = baseDraft({
      acquisitionMessage: { resolvedPartnerId: null, senderDomain: "partner.fr" },
    })
    const domainPartner = partner({
      requireExactEmail: false,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
    })
    await maybeRunAutoDecisionAfterExtraction({
      companyId: "co1",
      draftId: "d1",
      deps: deps({
        partner: null,
        domainFallbackPartner: domainPartner,
      }),
    })
    assert.equal(approveCalls, 1)
    assert.equal(convertCalls, 1)
    assert.equal(draft.status, "CONVERTED")
    assert.ok(journalEntries.some((j) => j.decisionCode === "AUTO_APPROVE_CONVERT"))
  })
})
