/**
 * PLAN-ACQ-CONSULTATIONS — ISO week FIX-001/002/002B (ISO-only index proof subset).
 * Tests purement locaux (pas de DB distante, pas d’API Anthropic).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyDeterministicPostEnrichment,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"
import {
  isoWeekToDateRange,
  isoWeeksInYear,
  resolveIsoWeekYearFromReferenceDate,
} from "@/lib/acquisition/extraction/iso-week"
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
    consultationReference: null,
    description: null,
    attachmentClassifications: [],
    interventionNature: null,
    constraints: null,
    clientReference: null,
    requestClassification: null,
    estimatedDurationHours: null,
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

