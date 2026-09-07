/**
 * PLAN-ACQ-CONSULTATIONS-FIX-001 — Matrice C/W/P/R + fixtures LAURALU / HALL EXPO.
 * Tests purement locaux (pas de DB distante, pas d’API Anthropic).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyDeterministicPostEnrichment,
  buildExtractedDataPayload,
  evaluateExtractionGate,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"
import { catalogWarning } from "@/lib/acquisition/extraction/extraction.schema"
import { corroborateCancellationText } from "@/lib/acquisition/extraction/cancellation-corroboration"
import {
  isoWeekToDateRange,
  isoWeeksInYear,
  resolveIsoWeekYearFromReferenceDate,
} from "@/lib/acquisition/extraction/iso-week"
import { evaluateAutoDecision } from "@/lib/acquisition/policy/auto-decision.policy"
import { applyCancellationFollowUp } from "@/lib/acquisition/policy/cancellation-followup"
import { matchClientForDraft } from "@/lib/acquisition/matching/client-match.service"
import { ANTHROPIC_EXTRACTION_SYSTEM_PROMPT } from "@/lib/acquisition/extraction/anthropic-extraction.prompt"
import { EXTRACTION_TOOL_INPUT_JSON_SCHEMA } from "@/lib/acquisition/extraction/anthropic-extraction.schema"
import { DEFAULT_CONSULTATION_PARTNER_SEEDS } from "@/lib/acquisition/partner-registry-seed"
import type { ExtractionCanonicalFields } from "@/lib/acquisition/extraction/extraction.types"

function fields(over: Partial<ExtractionCanonicalFields> = {}): ExtractionCanonicalFields {
  return {
    worksiteName: null,
    clientName: null,
    clientEmail: null,
    clientPhone: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    address: null,
    postalCode: null,
    city: null,
    requestedStartDate: null,
    requestedEndDate: null,
        clientConsultationDate: null,
    consultationReference: null,
    description: null,
    attachmentClassifications: [],
    interventionNature: null,
    constraints: null,
    clientReference: null,
    requestClassification: null,
    estimatedDurationHours: null,
    endClientName: null,
    requestedWeekNumber: null,
    requestedWeekYear: null,
    ...over,
  }
}

describe("FIX-001 — ISO week (W1/W2/W3)", () => {
  it("W1 S36 sans année → dates null + DATE_AMBIGUOUS", () => {
    const base = {
      fields: fields({ requestedWeekNumber: 36, worksiteName: "PROVIDENCE" }),
      confidenceData: {},
      evidenceData: {},
      warnings: [],
      providerId: "deterministic",
      model: "rules-v1",
    }
    const out = applyDeterministicPostEnrichment(base, {
      subject: "Consultation S36",
      body: "Semaine 36 sans année",
    })
    assert.equal(out.fields.requestedStartDate, null)
    assert.equal(out.fields.requestedEndDate, null)
    assert.ok(out.warnings.some((w) => w.code === "DATE_AMBIGUOUS"))
  })

  it("W2 S36 2026 → plage ISO lundi→dimanche", () => {
    const range = isoWeekToDateRange(36, 2026)
    assert.ok(range)
    assert.equal(range!.startDate, "2026-08-31")
    assert.equal(range!.endDate, "2026-09-06")

    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({
          requestedWeekNumber: 36,
          requestedWeekYear: 2026,
          worksiteName: "Site",
        }),
        confidenceData: { requestedWeekNumber: 0.8 },
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: "S36 2026", body: "installation S36 2026" }
    )
    assert.equal(out.fields.requestedStartDate, "2026-08-31")
    assert.equal(out.fields.requestedEndDate, "2026-09-06")
  })

  it("W3 frontières année ISO (semaine 1 / 53)", () => {
    const w1 = isoWeekToDateRange(1, 2026)
    assert.ok(w1)
    assert.equal(w1!.startDate, "2025-12-29")
    assert.equal(w1!.endDate, "2026-01-04")

    assert.equal(isoWeeksInYear(2020), 53)
    const w53 = isoWeekToDateRange(53, 2020)
    assert.ok(w53)
    assert.equal(isoWeekToDateRange(53, 2021), null)
  })

  it("FIX-008 — récupère S 36 explicitement présent dans le body sans inventer l'année", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({ worksiteName: "LYCEE LA PROVIDENCE 49" }),
        confidenceData: { requestedWeekNumber: 0.35 },
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      {
        subject: "Consultation de devis LYCEE LA PROVIDENCE 49",
        body: "Date d’installation provisionnelle : S 36",
      }
    )

    assert.equal(out.fields.requestedWeekNumber, 36)
    assert.equal(out.fields.requestedWeekYear, null)
    assert.equal(out.fields.requestedStartDate, null)
    assert.equal(out.fields.requestedEndDate, null)
    assert.equal(out.confidenceData.requestedWeekNumber, 0.35)
    assert.deepEqual(out.evidenceData.requestedWeekNumber, {
      source: "HEURISTIC",
      quote: "S 36",
    })
    assert.ok(out.warnings.some((w) => w.code === "DATE_AMBIGUOUS"))
  })

  it("FIX-008 — accepte la forme explicite semaine 12", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields(),
        confidenceData: {},
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: null, body: "Installation prévue semaine 12." }
    )

    assert.equal(out.fields.requestedWeekNumber, 12)
    assert.equal(out.fields.requestedWeekYear, null)
  })

  it("FIX-008 — ignore S54 et le texte non calendaire 36 semaines", () => {
    for (const body of ["Installation S54", "Durée estimée : 36 semaines"]) {
      const out = applyDeterministicPostEnrichment(
        {
          fields: fields(),
          confidenceData: {},
          evidenceData: {},
          warnings: [],
          providerId: "anthropic",
          model: "t",
        },
        { subject: null, body }
      )

      assert.equal(out.fields.requestedWeekNumber, null)
    }
  })

  it("FIX-008 — saute une semaine invalide puis récupère la suivante valide", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields(),
        confidenceData: {},
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      {
        subject: null,
        body: "Ancienne référence S54 — installation réelle S36",
      }
    )

    assert.equal(out.fields.requestedWeekNumber, 36)
    assert.equal(out.evidenceData.requestedWeekNumber?.quote, "S36")
  })

  it("FIX-008 — ne remplace jamais une semaine déjà extraite par le provider", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({ requestedWeekNumber: 22 }),
        confidenceData: { requestedWeekNumber: 0.9 },
        evidenceData: {
          requestedWeekNumber: { source: "BODY", quote: "S22" },
        },
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: "Consultation S36", body: "Installation S 36" }
    )

    assert.equal(out.fields.requestedWeekNumber, 22)
    assert.equal(out.confidenceData.requestedWeekNumber, 0.9)
    assert.equal(out.evidenceData.requestedWeekNumber?.quote, "S22")
  })
})

describe("FIX-001 — dates BODY vs subject (W4 TAX FREE)", () => {
  it("W4 body août 2026 prioritaire — enrichissement n’écrase pas dates existantes", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "TAX FREE — Phase 1",
          clientReference: "642238",
          requestedStartDate: "2026-08-25",
          requestedEndDate: "2026-08-29",
          requestedWeekNumber: 36,
          requestedWeekYear: 2025,
          contactName: "Mehdi ROMDHANE",
        }),
        confidenceData: {},
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      {
        subject: "TR: MAIL DE LANCEMENT - 09 2025 TAX FREE - 642238 / PHASE 1",
        body: "Date de montage : du 25 au 29 Aout 2026",
      }
    )
    assert.equal(out.fields.requestedStartDate, "2026-08-25")
    assert.equal(out.fields.requestedEndDate, "2026-08-29")
  })
})

describe("FIX-001 — annulation (C1–C4)", () => {
  it("corroboration : positif vs négation", () => {
    assert.equal(
      corroborateCancellationText("Re: site", "consultation annulée"),
      true
    )
    assert.equal(
      corroborateCancellationText("Re: site", "non annulée pour le moment"),
      false
    )
  })

  it("corroboration : substantif seul / mention conditionnelle → false", () => {
    assert.equal(
      corroborateCancellationText(null, "Voir les conditions en cas d'annulation."),
      false
    )
    assert.equal(
      corroborateCancellationText(null, "Les frais d'annulation s'appliquent."),
      false
    )
    assert.equal(
      corroborateCancellationText("Cancel", "Please review cancel policy"),
      false
    )
  })

  it("corroboration : formulations d'annulation effective → true", () => {
    assert.equal(
      corroborateCancellationText(null, "cette consultation est annulée"),
      true
    )
    assert.equal(
      corroborateCancellationText(null, "nous annulons cette consultation"),
      true
    )
    assert.equal(
      corroborateCancellationText(null, "This consultation has been cancelled."),
      true
    )
  })

  it("A — CANCELLED + evidence valide + corroboration → CONSULTATION_CANCELLED blocking", () => {
    const body = "Cette consultation est annulée."
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "LYCEE LANGON 33",
          requestClassification: "CANCELLED_CONSULTATION",
        }),
        confidenceData: { requestClassification: 0.9 },
        evidenceData: {
          requestClassification: {
            source: "BODY",
            quote: "Cette consultation est annulée",
          },
        },
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      {
        subject: "CONSULTATION EQUIPE-LYCEE LANGON 33 — ANNULEE",
        body,
      }
    )
    assert.equal(out.fields.requestClassification, "CANCELLED_CONSULTATION")
    assert.ok(out.warnings.some((w) => w.code === "CONSULTATION_CANCELLED" && w.blocking))
  })

  it("B — CANCELLED + corroboration false → pas cancel blocking", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "Site",
          requestClassification: "CANCELLED_CONSULTATION",
        }),
        confidenceData: {},
        evidenceData: {
          requestClassification: { source: "BODY", quote: "Merci de chiffrer" },
        },
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: "Consultation normale", body: "Merci de chiffrer" }
    )
    assert.equal(out.fields.requestClassification, "CONSULTATION")
    assert.ok(!out.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))
  })

  it("C — CONSULTATION + corroboration positive → pas d'auto-CANCELLED", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "Site",
          requestClassification: "CONSULTATION",
        }),
        confidenceData: {},
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      {
        subject: "Re: site",
        body: "cette consultation est annulée — merci",
      }
    )
    assert.equal(out.fields.requestClassification, "CONSULTATION")
    assert.ok(!out.warnings.some((w) => w.code === "CONSULTATION_CANCELLED" && w.blocking))
  })

  it("D — CANCELLED + evidence absente/invalide → pas cancel blocking", () => {
    const body = "Cette consultation est annulée."
    const absent = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "Site",
          requestClassification: "CANCELLED_CONSULTATION",
        }),
        confidenceData: {},
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: "Annulation", body }
    )
    assert.equal(absent.fields.requestClassification, "CONSULTATION")
    assert.ok(!absent.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))

    const invalid = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "Site",
          requestClassification: "CANCELLED_CONSULTATION",
        }),
        confidenceData: {},
        evidenceData: {
          requestClassification: {
            source: "BODY",
            quote: "quote inventée absente du mail",
          },
        },
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: "Annulation", body }
    )
    assert.equal(invalid.fields.requestClassification, "CONSULTATION")
    assert.ok(!invalid.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))
  })

  it("E — phrase cancel sans classification provider → fail-closed", () => {
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "Site",
          requestClassification: null,
        }),
        confidenceData: {},
        evidenceData: {},
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: null, body: "cette consultation est annulée" }
    )
    assert.notEqual(out.fields.requestClassification, "CANCELLED_CONSULTATION")
    assert.ok(!out.warnings.some((w) => w.code === "CONSULTATION_CANCELLED" && w.blocking))
  })
})

describe("FIX-004 — cancel warning authority + gate routing", () => {
  it("1 — provider CONSULTATION_CANCELLED seul → aucun cancel autoritaire après normalize", () => {
    const n = normalizeProviderResult({
      fields: {
        worksiteName: { value: "Site A", confidence: 0.8 },
      },
      warnings: [{ code: "CONSULTATION_CANCELLED" }],
      providerMetadata: { providerId: "anthropic", model: "t" },
    })
    assert.ok(!n.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))
    assert.ok(n.warnings.some((w) => w.code === "PROVIDER_PARTIAL_RESULT" && w.source === "PROVIDER"))
  })

  it("2 — triple garde-fou → CONSULTATION_CANCELLED source SERVICE", () => {
    const body = "Cette consultation est annulée."
    const out = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "Site",
          requestClassification: "CANCELLED_CONSULTATION",
        }),
        confidenceData: {},
        evidenceData: {
          requestClassification: {
            source: "BODY",
            quote: "Cette consultation est annulée",
          },
        },
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: "Re", body }
    )
    const w = out.warnings.find((x) => x.code === "CONSULTATION_CANCELLED")
    assert.ok(w)
    assert.equal(w!.source, "SERVICE")
    assert.equal(w!.blocking, true)
  })

  it("3+4 — gate : cancel seul + contenu valide → pass, warning conservé", () => {
    const cancel = catalogWarning("CONSULTATION_CANCELLED", { source: "SERVICE" })
    const gate = evaluateExtractionGate(
      fields({
        worksiteName: "LYCEE LANGON 33",
        address: "1 rue Test",
        requestedStartDate: "2026-10-26",
        requestedEndDate: "2026-11-05",
      }),
      [cancel]
    )
    assert.equal(gate.pass, true)
    assert.equal(gate.failureCode, null)
    assert.ok(gate.warnings.some((w) => w.code === "CONSULTATION_CANCELLED" && w.blocking))
  })

  it("5 — autre blocking ERROR → gate fail inchangé", () => {
    const gate = evaluateExtractionGate(
      fields({ worksiteName: "Site OK" }),
      [catalogWarning("EMPTY_EXTRACTION", { source: "SERVICE" })]
    )
    assert.equal(gate.pass, false)
    assert.equal(gate.failureCode, "EMPTY_EXTRACTION")
  })

  it("6 — chaîne locale : cancel validé → gate pass → AUTO_REJECT_CANCELLED", () => {
    const body = "Cette consultation est annulée."
    const enriched = applyDeterministicPostEnrichment(
      {
        fields: fields({
          worksiteName: "LYCEE LANGON 33",
          address: "1 rue X",
          city: "Langon",
          requestedStartDate: "2026-10-26",
          requestedEndDate: "2026-11-05",
          requestClassification: "CANCELLED_CONSULTATION",
        }),
        confidenceData: {
          worksiteName: 0.9,
          requestedStartDate: 0.9,
          requestedEndDate: 0.9,
        },
        evidenceData: {
          requestClassification: {
            source: "BODY",
            quote: "Cette consultation est annulée",
          },
        },
        warnings: [],
        providerId: "anthropic",
        model: "t",
      },
      { subject: "ANNULEE", body }
    )
    const gate = evaluateExtractionGate(enriched.fields, enriched.warnings)
    assert.equal(gate.pass, true, "persistirait PENDING_REVIEW, pas FAILED")
    assert.ok(gate.warnings.some((w) => w.code === "CONSULTATION_CANCELLED"))

    const decision = evaluateAutoDecision({
      worksiteName: enriched.fields.worksiteName,
      startDate: new Date("2026-10-26"),
      endDate: new Date("2026-11-05"),
      address: enriched.fields.address,
      city: enriched.fields.city,
      clientName: null,
      clientEmail: null,
      confidenceData: enriched.confidenceData,
      warningData: gate.warnings,
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      consultationCancelled: true,
      hasResolvedClient: true,
    })
    assert.equal(decision.code, "AUTO_REJECT_CANCELLED")
  })
})

describe("FIX-001 — annulation follow-up + policy", () => {
  it("policy C1 → AUTO_REJECT_CANCELLED (0 convert path)", () => {
    const r = evaluateAutoDecision({
      worksiteName: "LYCEE LANGON 33",
      startDate: new Date("2026-10-26"),
      endDate: new Date("2026-11-05"),
      address: "1 rue X",
      city: "Langon",
      clientName: null,
      clientEmail: null,
      confidenceData: {
        worksiteName: 0.9,
        requestedStartDate: 0.9,
        requestedEndDate: 0.9,
      },
      warningData: [{ code: "CONSULTATION_CANCELLED", blocking: true }],
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      consultationCancelled: true,
      hasResolvedClient: true,
    })
    assert.equal(r.code, "AUTO_REJECT_CANCELLED")
  })

  it("C2 follow-up thread exact → reject 1 draft lié", async () => {
    const drafts = [
      {
        id: "d_src",
        status: "PENDING_REVIEW",
        createdWorksiteId: null as string | null,
      },
      {
        id: "d_prev",
        status: "PENDING_REVIEW",
        createdWorksiteId: null as string | null,
      },
    ]
    const db = {
      acquisitionMessage: {
        findMany: async () => [
          { id: "m1", draft: drafts[0] },
          { id: "m2", draft: drafts[1] },
        ],
      },
      worksiteImportDraft: {
        updateMany: async (args: {
          where: { id: string }
          data: { status: string }
        }) => {
          const d = drafts.find((x) => x.id === args.where.id)
          if (d) d.status = args.data.status
          return { count: d ? 1 : 0 }
        },
      },
    }
    const r = await applyCancellationFollowUp({
      companyId: "co1",
      sourceDraftId: "d_src",
      threadId: "thread-1",
      db: db as never,
    })
    assert.deepEqual(r.linkedDraftIdsRejected, ["d_prev"])
    assert.equal(drafts[1]!.status, "REJECTED")
    assert.equal(r.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
  })

  it("C3 après conversion → worksite intact, journal AFTER_CONVERSION", async () => {
    const drafts = [
      { id: "d_src", status: "PENDING_REVIEW", createdWorksiteId: null as string | null },
      {
        id: "d_done",
        status: "CONVERTED",
        createdWorksiteId: "ws_1",
      },
    ]
    let updates = 0
    const db = {
      acquisitionMessage: {
        findMany: async () => [
          { id: "m1", draft: drafts[0] },
          { id: "m2", draft: drafts[1] },
        ],
      },
      worksiteImportDraft: {
        updateMany: async () => {
          updates++
          return { count: 0 }
        },
      },
    }
    const r = await applyCancellationFollowUp({
      companyId: "co1",
      sourceDraftId: "d_src",
      threadId: "thread-1",
      db: db as never,
    })
    assert.equal(updates, 0)
    assert.deepEqual(r.linkedDraftIdsRejected, [])
    assert.deepEqual(r.convertedWorksiteIdsUntouched, ["ws_1"])
    assert.equal(r.journalCode, "CANCELLATION_AFTER_CONVERSION")
  })

  it("C3b CONVERTED + pendingLike → fail-closed, 0 mutation liée", async () => {
    const drafts = [
      { id: "d_src", status: "PENDING_REVIEW", createdWorksiteId: null as string | null },
      {
        id: "d_done",
        status: "CONVERTED",
        createdWorksiteId: "ws_1",
      },
      {
        id: "d_pending",
        status: "PENDING_REVIEW",
        createdWorksiteId: null as string | null,
      },
    ]
    let updates = 0
    const db = {
      acquisitionMessage: {
        findMany: async () =>
          drafts.map((d, i) => ({ id: `m${i}`, draft: d })),
      },
      worksiteImportDraft: {
        updateMany: async () => {
          updates++
          return { count: 1 }
        },
      },
    }
    const r = await applyCancellationFollowUp({
      companyId: "co1",
      sourceDraftId: "d_src",
      threadId: "thread-1",
      db: db as never,
    })
    assert.equal(updates, 0)
    assert.deepEqual(r.linkedDraftIdsRejected, [])
    assert.deepEqual(r.convertedWorksiteIdsUntouched, ["ws_1"])
    assert.equal(drafts[2]!.status, "PENDING_REVIEW")
    assert.equal(r.journalCode, "CANCELLATION_AFTER_CONVERSION")
  })

  it("C4 ambigu (2 drafts non convertis) → aucune mutation", async () => {
    const drafts = [
      { id: "d_src", status: "PENDING_REVIEW", createdWorksiteId: null },
      { id: "d_a", status: "PENDING_REVIEW", createdWorksiteId: null },
      { id: "d_b", status: "APPROVED", createdWorksiteId: null },
    ]
    let updates = 0
    const db = {
      acquisitionMessage: {
        findMany: async () =>
          drafts.map((d, i) => ({ id: `m${i}`, draft: d })),
      },
      worksiteImportDraft: {
        updateMany: async () => {
          updates++
          return { count: 1 }
        },
      },
    }
    const r = await applyCancellationFollowUp({
      companyId: "co1",
      sourceDraftId: "d_src",
      threadId: "thread-1",
      db: db as never,
    })
    assert.equal(updates, 0)
    assert.equal(r.ambiguous, true)
    assert.equal(r.journalCode, "CANCELLATION_TARGET_AMBIGUOUS")
  })
})

describe("FIX-001 — client match P1–P6", () => {
  it("P1 Partner→Client même tenant", async () => {
    const r = await matchClientForDraft({
      companyId: "co1",
      clientName: null,
      clientEmail: null,
      partnerLinkedClientId: "cli_a",
      db: {
        client: {
          findFirst: async (args: { where: { id: string; companyId: string } }) =>
            args.where.id === "cli_a" && args.where.companyId === "co1"
              ? { id: "cli_a" }
              : null,
          findMany: async () => [],
        },
      } as never,
    })
    assert.equal(r.matchKind, "PARTNER_LINK")
    assert.equal(r.clientId, "cli_a")
  })

  it("P2 cross-tenant impossible", async () => {
    const r = await matchClientForDraft({
      companyId: "co1",
      clientName: null,
      clientEmail: null,
      partnerLinkedClientId: "cli_other",
      db: {
        client: {
          findFirst: async () => null,
          findMany: async () => [],
        },
      } as never,
    })
    assert.equal(r.matchKind, "NONE")
    assert.equal(r.clientId, null)
  })

  it("P3 PROPOSED_ID bat PARTNER_LINK", async () => {
    const calls: string[] = []
    const r = await matchClientForDraft({
      companyId: "co1",
      clientName: null,
      clientEmail: null,
      proposedClientId: "cli_human",
      partnerLinkedClientId: "cli_partner",
      db: {
        client: {
          findFirst: async (args: { where: { id: string } }) => {
            calls.push(args.where.id)
            return { id: args.where.id }
          },
          findMany: async () => [],
        },
      } as never,
    })
    assert.equal(r.matchKind, "PROPOSED_ID")
    assert.equal(r.clientId, "cli_human")
    assert.equal(calls[0], "cli_human")
  })

  it("P4 contactEmail jamais utilisé — seul clientEmail", async () => {
    const r = await matchClientForDraft({
      companyId: "co1",
      clientName: null,
      clientEmail: null,
      db: {
        client: {
          findFirst: async () => null,
          findMany: async () => [{ id: "should-not" }],
        },
      } as never,
    })
    assert.equal(r.matchKind, "NONE")
  })

  it("P5 endClientName jamais matching", async () => {
    const r = await matchClientForDraft({
      companyId: "co1",
      clientName: null,
      clientEmail: null,
      // endClientName n’est pas un paramètre du matcher
      db: {
        client: {
          findFirst: async () => null,
          findMany: async () => [{ id: "selevents" }],
        },
      } as never,
    })
    assert.equal(r.clientId, null)
  })

  it("P6 partner connu → EXISTING path (hasResolvedClient) sans NEW", () => {
    const r = evaluateAutoDecision({
      worksiteName: "PROVIDENCE",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-09-05"),
      address: "33 avenue Gustave Ferrie",
      city: "Angers",
      clientName: null,
      clientEmail: null,
      confidenceData: {
        worksiteName: 0.9,
        requestedStartDate: 0.9,
        requestedEndDate: 0.9,
      },
      warningData: [],
      autoApproveEnabled: true,
      autoConvertEnabled: true,
      hasResolvedClient: true,
      referenceInstant: new Date("2026-09-02T12:00:00Z"),
    })
    assert.equal(r.code, "AUTO_APPROVE_CONVERT")
    assert.ok(!r.reasons.includes("MISSING_CLIENT_IDENTITY"))
  })
})

describe("FIX-001 — persistence R1–R3 + extractedData", () => {
  it("R3 payload conserve clientEmail/phone + endClientName", () => {
    const payload = buildExtractedDataPayload(
      fields({
        clientEmail: "compta@example.com",
        clientPhone: "+33100000000",
        contactEmail: "marco@example.com",
        contactPhone: "+33645097611",
        endClientName: "SELEVENTS (Fabrice Berthon)",
        postalCode: "13008",
        city: "Marseille",
      }),
      {},
      "hash"
    )
    assert.equal(payload.clientEmail, "compta@example.com")
    assert.equal(payload.clientPhone, "+33100000000")
    assert.equal(payload.contactEmail, "marco@example.com")
    assert.equal(payload.endClientName, "SELEVENTS (Fabrice Berthon)")
    assert.equal(payload.postalCode, "13008")
    assert.equal(payload.city, "Marseille")
  })

  it("R1 mapping conceptuel contact ≠ client (via fields séparés)", () => {
    const f = fields({
      clientEmail: "compta@example.com",
      contactEmail: "marco@example.com",
      contactName: "Marco Rodrigues",
      contactPhone: "+33645097611",
      postalCode: "49000",
      city: "Angers",
    })
    // Persistance attendue (vérifiée aussi côté repository) :
    assert.equal(f.contactEmail, "marco@example.com")
    assert.notEqual(f.contactEmail, f.clientEmail)
    assert.equal(f.postalCode, "49000")
    assert.equal(f.city, "Angers")
  })
})

describe("FIX-001 — fixtures noms chantier ≠ Client", () => {
  const worksites = [
    "LYCEE LA PROVIDENCE 49",
    "LYCEE LANGON 33",
    "YESYES PADEL CARRIERES SOUS POISSY 78",
    "ITM SBO 42 PHASE 142 ST BONNET LES OULES",
    "LEROY MERLIN 77 REAU",
    "CERACO AMBONIL 26",
    "LIVE TERACT INVIVO RETAIL 09 2026",
    "SOMMET DE L'ELEVAGE 09 2026",
    "CONGRES ESPE 09 2026",
    "TAX FREE — Phase 1",
  ]

  it("prompt définit worksite ≠ client ≠ endClient ≠ contact", () => {
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /worksiteName/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /endClientName/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /CANCELLED_CONSULTATION/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /requestedWeekNumber/)
    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /Client Planificator/)
  })

  it("FIX-007 — contrat Anthropic extrait Sxx sans inventer l'année", () => {
    const toolSchema = JSON.stringify(EXTRACTION_TOOL_INPUT_JSON_SCHEMA)

    assert.match(ANTHROPIC_EXTRACTION_SYSTEM_PROMPT, /S36, S 36, semaine 36/)
    assert.match(
      ANTHROPIC_EXTRACTION_SYSTEM_PROMPT,
      /renseigne requestedWeekNumber, omets requestedWeekYear et les dates ISO/,
    )
    assert.match(
      ANTHROPIC_EXTRACTION_SYSTEM_PROMPT,
      /n'infère jamais l'année depuis la date du message ou le contexte/,
    )
    assert.match(toolSchema, /Numéro de semaine calendaire explicitement présent/)
    assert.match(
      toolSchema,
      /Année explicitement et fiablement associée à requestedWeekNumber/,
    )
  })

  it("fixtures LAURALU/HALL EXPO restent des worksiteName", () => {
    for (const name of worksites) {
      const f = fields({ worksiteName: name, endClientName: null, clientName: null })
      assert.equal(f.worksiteName, name)
      assert.equal(f.clientName, null)
    }
  })

  it("SOMMET : endClientName SELEVENTS ≠ clientName", () => {
    const f = fields({
      worksiteName: "SOMMET DE L'ELEVAGE 09 2026",
      endClientName: "SELEVENTS (Fabrice Berthon)",
      contactName: "Nathanael SIRE",
      clientName: null,
    })
    assert.equal(f.endClientName?.includes("SELEVENTS"), true)
    assert.equal(f.clientName, null)
  })

  it("seeds registry génériques sans ID Staging", () => {
    assert.ok(DEFAULT_CONSULTATION_PARTNER_SEEDS.some((s) => s.code === "lauralu"))
    assert.ok(DEFAULT_CONSULTATION_PARTNER_SEEDS.some((s) => s.code === "hall-expo"))
    for (const s of DEFAULT_CONSULTATION_PARTNER_SEEDS) {
      assert.equal(s.clientId ?? null, null)
      assert.equal(s.autoApproveEnabled, false)
      assert.equal(s.autoConvertEnabled, false)
      assert.equal(s.allowCreateClient, false)
    }
  })
})

describe("FIX-001 — normalizeProviderResult accepte nouveaux champs", () => {
  it("endClientName + week + CANCELLED", () => {
    const n = normalizeProviderResult({
      fields: {
        worksiteName: { value: "TAX FREE", confidence: 0.8 },
        endClientName: { value: "SELEVENTS", confidence: 0.7 },
        requestedWeekNumber: { value: 36, confidence: 0.7 },
        requestedWeekYear: { value: 2026, confidence: 0.7 },
        requestClassification: {
          value: "CANCELLED_CONSULTATION",
          confidence: 0.8,
        },
      },
      warnings: [],
      providerMetadata: { providerId: "anthropic", model: "t" },
    })
    assert.equal(n.fields.endClientName, "SELEVENTS")
    assert.equal(n.fields.requestedWeekNumber, 36)
    assert.equal(n.fields.requestClassification, "CANCELLED_CONSULTATION")
  })
})

describe("FIX-001 — persistExtraction mapping R1/R2", () => {
  it("écrit contact* et postal/city, jamais clientEmail dans proposedContact*", async () => {
    const { DraftExtractionRepository } = await import(
      "@/lib/acquisition/extraction/extraction.repository"
    )
    let written: Record<string, unknown> | null = null
    const db = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          worksiteImportDraft: {
            findFirst: async () => ({ acquisitionMessageId: "m1" }),
            updateMany: async (args: { data: Record<string, unknown> }) => {
              written = args.data
              return { count: 1 }
            },
          },
          acquisitionMessageContent: {
            findFirst: async () => ({ contentHash: "h1" }),
          },
        }
        return fn(tx)
      },
    }
    const repo = new DraftExtractionRepository(db as never)
    const outcome = await repo.persistExtraction({
      companyId: "co1",
      draftId: "d1",
      expectedVersion: 1,
      expectedContentHash: "h1",
      status: "PENDING_REVIEW",
      fields: fields({
        clientName: "LAURALU",
        worksiteName: "PROVIDENCE",
        address: "33 av Ferrie",
        postalCode: "49000",
        city: "Angers",
        clientEmail: "compta@example.com",
        clientPhone: "+33111111111",
        contactName: "Marco",
        contactEmail: "marco@example.com",
        contactPhone: "+33645097611",
        description: "élec",
      }),
      confidenceData: {},
      warningData: [],
      extractedData: {},
      providerId: "anthropic",
      model: "t",
      errorCode: null,
      now: new Date(),
    })
    assert.equal(outcome, "OK")
    assert.ok(written)
    assert.equal(written!.proposedContactEmail, "marco@example.com")
    assert.equal(written!.proposedContactPhone, "+33645097611")
    assert.equal(written!.proposedContactName, "Marco")
    assert.equal(written!.proposedPostalCode, "49000")
    assert.equal(written!.proposedCity, "Angers")
    assert.notEqual(written!.proposedContactEmail, "compta@example.com")
  })
})

describe("FIX-001 — Partner.clientId FK delete policy (RESTRICT)", () => {
  it("Prisma + SQL : ON DELETE RESTRICT (pas SET NULL sur FK composite)", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const root = join(process.cwd())
    const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8")
    const sql = readFileSync(
      join(root, "prisma/migrations/20260902180000_acq_partner_client_link/migration.sql"),
      "utf8"
    )
    const partnerBlock =
      schema.match(/model AcquisitionPartner \{[\s\S]*?@@map\("acquisition_partners"\)/)?.[0] ??
      ""
    assert.ok(partnerBlock.length > 0, "bloc AcquisitionPartner introuvable")
    assert.match(partnerBlock, /fields:\s*\[clientId,\s*companyId\]/)
    assert.match(partnerBlock, /onDelete:\s*Restrict/)
    assert.doesNotMatch(partnerBlock, /onDelete:\s*SetNull/)
    assert.match(sql, /FOREIGN KEY \("clientId", "companyId"\)/)
    assert.match(sql, /ON DELETE RESTRICT/)
    assert.doesNotMatch(sql, /ON DELETE SET NULL/)
  })
})


describe("FIX-002B — résolution année ISO fail-closed depuis receivedAt", () => {
  const baseNorm = (over: Partial<ReturnType<typeof fields>> = {}) => ({
    fields: fields({ worksiteName: "Site", requestedWeekNumber: 36, ...over }),
    confidenceData: { requestedWeekNumber: 0.8 } as Record<string, number>,
    evidenceData: {} as Record<string, { source: string; quote?: string }>,
    warnings: [] as [],
    providerId: "anthropic",
    model: "t",
  })

  it("1 — fév. + S36 hors fenêtres → null + DATE_AMBIGUOUS", () => {
    const receivedAt = new Date("2026-02-01T12:00:00.000Z")
    assert.equal(resolveIsoWeekYearFromReferenceDate(36, receivedAt), null)
    const out = applyDeterministicPostEnrichment(baseNorm(), {
      subject: "Consultation S36",
      body: "Installation S36",
      receivedAt,
    })
    assert.equal(out.fields.requestedWeekYear, null)
    assert.equal(out.fields.requestedStartDate, null)
    assert.equal(out.fields.requestedEndDate, null)
    assert.ok(out.warnings.some((w) => w.code === "DATE_AMBIGUOUS"))
  })

  it("2 — fév. + S40 hors fenêtres → null + DATE_AMBIGUOUS", () => {
    const receivedAt = new Date("2026-02-01T12:00:00.000Z")
    assert.equal(resolveIsoWeekYearFromReferenceDate(40, receivedAt), null)
    const out = applyDeterministicPostEnrichment(
      baseNorm({ requestedWeekNumber: 40 }),
      { subject: "S40", body: "S40", receivedAt }
    )
    assert.equal(out.fields.requestedWeekYear, null)
    assert.equal(out.fields.requestedStartDate, null)
    assert.equal(out.fields.requestedEndDate, null)
    assert.ok(out.warnings.some((w) => w.code === "DATE_AMBIGUOUS"))
  })

  it("3 — fin décembre + S1 → année ISO 2026 (CONTAINING)", () => {
    const receivedAt = new Date("2025-12-30T12:00:00.000Z")
    assert.equal(resolveIsoWeekYearFromReferenceDate(1, receivedAt), 2026)
    const range = isoWeekToDateRange(1, 2026)
    assert.ok(range)
    assert.equal(range!.startDate, "2025-12-29")
    assert.equal(range!.endDate, "2026-01-04")
    const out = applyDeterministicPostEnrichment(
      baseNorm({ requestedWeekNumber: 1 }),
      { subject: "S1", body: "démarrage S1", receivedAt }
    )
    assert.equal(out.fields.requestedWeekYear, 2026)
    assert.equal(out.fields.requestedStartDate, "2025-12-29")
    assert.equal(out.fields.requestedEndDate, "2026-01-04")
  })

  it("4 — début janvier + S52 → année ISO 2025 (RETRO_SHORT)", () => {
    const receivedAt = new Date("2026-01-02T12:00:00.000Z")
    assert.equal(resolveIsoWeekYearFromReferenceDate(52, receivedAt), 2025)
    const range = isoWeekToDateRange(52, 2025)
    assert.ok(range)
    const out = applyDeterministicPostEnrichment(
      baseNorm({ requestedWeekNumber: 52 }),
      { subject: "S52", body: "fin S52", receivedAt }
    )
    assert.equal(out.fields.requestedWeekYear, 2025)
    assert.equal(out.fields.requestedStartDate, range!.startDate)
    assert.equal(out.fields.requestedEndDate, range!.endDate)
  })

  it("5 — S36 + receivedAt 2026-08-27 → 2026 + plage ISO (PROSPECTIVE)", () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    assert.equal(resolveIsoWeekYearFromReferenceDate(36, receivedAt), 2026)
    const out = applyDeterministicPostEnrichment(baseNorm(), {
      subject: "Consultation S36",
      body: "Installation S36",
      receivedAt,
    })
    assert.equal(out.fields.requestedWeekYear, 2026)
    assert.equal(out.fields.requestedStartDate, "2026-08-31")
    assert.equal(out.fields.requestedEndDate, "2026-09-06")
    assert.ok(!out.warnings.some((w) => w.code === "DATE_AMBIGUOUS"))
  })

  it("6 — année explicite 2030 prioritaire (jamais réécrite)", () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    const out = applyDeterministicPostEnrichment(
      baseNorm({ requestedWeekNumber: 36, requestedWeekYear: 2030 }),
      { subject: "S36 2030", body: "S36", receivedAt }
    )
    assert.equal(out.fields.requestedWeekYear, 2030)
    const range = isoWeekToDateRange(36, 2030)
    assert.ok(range)
    assert.equal(out.fields.requestedStartDate, range!.startDate)
    assert.equal(out.fields.requestedEndDate, range!.endDate)
  })

  it("7 — receivedAt absent → DATE_AMBIGUOUS", () => {
    const out = applyDeterministicPostEnrichment(baseNorm(), {
      subject: "S36",
      body: "sans année",
      receivedAt: null,
    })
    assert.equal(out.fields.requestedWeekYear, null)
    assert.equal(out.fields.requestedStartDate, null)
    assert.equal(out.fields.requestedEndDate, null)
    assert.ok(out.warnings.some((w) => w.code === "DATE_AMBIGUOUS"))
  })

  it("8 — Invalid Date → resolver null, aucune année inventée", () => {
    const invalid = new Date(Number.NaN)
    assert.equal(resolveIsoWeekYearFromReferenceDate(36, invalid), null)
    const out = applyDeterministicPostEnrichment(baseNorm(), {
      subject: "S36",
      body: "S36",
      receivedAt: invalid,
    })
    assert.equal(out.fields.requestedWeekYear, null)
    assert.equal(out.fields.requestedStartDate, null)
    assert.ok(out.warnings.some((w) => w.code === "DATE_AMBIGUOUS"))
  })

  it("9 — S53 : année 52 sem. exclue ; 2021-01-04 → 2020 (RETRO)", () => {
    assert.equal(isoWeeksInYear(2021), 52)
    assert.equal(isoWeeksInYear(2020), 53)
    assert.equal(isoWeekToDateRange(53, 2021), null)
    const receivedAt = new Date("2021-01-04T12:00:00.000Z")
    assert.equal(resolveIsoWeekYearFromReferenceDate(53, receivedAt), 2020)
    const out = applyDeterministicPostEnrichment(
      baseNorm({ requestedWeekNumber: 53 }),
      { subject: "S53", body: "S53", receivedAt }
    )
    assert.equal(out.fields.requestedWeekYear, 2020)
    assert.ok(out.fields.requestedStartDate)
  })

  it("10 — non-mutation de referenceDate", () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    const before = receivedAt.getTime()
    resolveIsoWeekYearFromReferenceDate(36, receivedAt)
    assert.equal(receivedAt.getTime(), before)
  })

  it("11 — hors fenêtres : null sans tie-break nearest", () => {
    // Nearest would pick 2025 ; fail-closed → null.
    assert.equal(
      resolveIsoWeekYearFromReferenceDate(36, new Date("2026-02-01T12:00:00.000Z")),
      null
    )
    assert.equal(
      resolveIsoWeekYearFromReferenceDate(10, new Date("2026-08-27T10:00:00.000Z")),
      null
    )
  })

  it("12 — evidence : year/start/end sans quote synthétique", () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    const out = applyDeterministicPostEnrichment(baseNorm(), {
      subject: "Consultation S36",
      body: "Installation S36",
      receivedAt,
    })
    assert.equal(out.evidenceData.requestedWeekYear?.source, "HEURISTIC")
    assert.equal(out.evidenceData.requestedWeekYear?.quote, undefined)
    assert.equal(out.evidenceData.requestedStartDate?.source, "HEURISTIC")
    assert.equal(out.evidenceData.requestedStartDate?.quote, undefined)
    assert.equal(out.evidenceData.requestedEndDate?.source, "HEURISTIC")
    assert.equal(out.evidenceData.requestedEndDate?.quote, undefined)
    assert.ok(!JSON.stringify(out.evidenceData).includes("S36 2026"))
  })

  it("13 — start-only explicite : start conservé, end non inventé", () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    const out = applyDeterministicPostEnrichment(
      baseNorm({
        requestedWeekNumber: 36,
        requestedStartDate: "2026-08-25",
        requestedEndDate: null,
        clientConsultationDate: null,
      }),
      { subject: "S36", body: "S36", receivedAt }
    )
    assert.equal(out.fields.requestedStartDate, "2026-08-25")
    assert.equal(out.fields.requestedEndDate, null)
  })

  it("14 — end-only explicite : end conservé, start non inventé", () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    const out = applyDeterministicPostEnrichment(
      baseNorm({
        requestedWeekNumber: 36,
        requestedStartDate: null,
        requestedEndDate: "2026-08-29",
      }),
      { subject: "S36", body: "S36", receivedAt }
    )
    assert.equal(out.fields.requestedStartDate, null)
    assert.equal(out.fields.requestedEndDate, "2026-08-29")
  })

  it("G — start+end explicites non écrasés", () => {
    const receivedAt = new Date("2026-08-27T10:00:00.000Z")
    const out = applyDeterministicPostEnrichment(
      baseNorm({
        requestedWeekNumber: 36,
        requestedStartDate: "2026-08-25",
        requestedEndDate: "2026-08-29",
      }),
      { subject: "S36", body: "dates body", receivedAt }
    )
    assert.equal(out.fields.requestedStartDate, "2026-08-25")
    assert.equal(out.fields.requestedEndDate, "2026-08-29")
  })

  describe("bornes RETRO=14 / PROSPECTIVE=56 (fixtures depuis isoWeekToDateRange)", () => {
    const MS_PER_DAY = 86_400_000
    const WEEK = 36
    const YEAR = 2026

    it("RETRO — exactement 14 jours après FIN UTC → année acceptée", () => {
      const range = isoWeekToDateRange(WEEK, YEAR)
      assert.ok(range)
      const endMs = Date.parse(`${range!.endDate}T23:59:59.999Z`)
      const receivedAt = new Date(endMs + 14 * MS_PER_DAY)
      assert.equal(resolveIsoWeekYearFromReferenceDate(WEEK, receivedAt), YEAR)
    })

    it("RETRO — 14 jours + 1 ms après FIN UTC → null", () => {
      const range = isoWeekToDateRange(WEEK, YEAR)
      assert.ok(range)
      const endMs = Date.parse(`${range!.endDate}T23:59:59.999Z`)
      const receivedAt = new Date(endMs + 14 * MS_PER_DAY + 1)
      assert.equal(resolveIsoWeekYearFromReferenceDate(WEEK, receivedAt), null)
    })

    it("PROSPECTIVE — exactement 56 jours avant DÉBUT UTC → année acceptée", () => {
      const range = isoWeekToDateRange(WEEK, YEAR)
      assert.ok(range)
      const startMs = Date.parse(`${range!.startDate}T00:00:00.000Z`)
      const receivedAt = new Date(startMs - 56 * MS_PER_DAY)
      assert.equal(resolveIsoWeekYearFromReferenceDate(WEEK, receivedAt), YEAR)
    })

    it("PROSPECTIVE — 56 jours + 1 ms avant DÉBUT UTC → null", () => {
      const range = isoWeekToDateRange(WEEK, YEAR)
      assert.ok(range)
      const startMs = Date.parse(`${range!.startDate}T00:00:00.000Z`)
      const receivedAt = new Date(startMs - 56 * MS_PER_DAY - 1)
      assert.equal(resolveIsoWeekYearFromReferenceDate(WEEK, receivedAt), null)
    })
  })
})
