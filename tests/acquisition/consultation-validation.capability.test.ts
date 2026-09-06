/**
 * PLAN-ACQ-AGENTS-LOT-2 — Tests ConsultationValidationCapability.
 * Locaux uniquement — pas de DB / Gmail / Anthropic.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import {
  consultationValidationCapability,
  validateConsultation,
  type ConsultationValidationSnapshot,
} from "@/lib/acquisition/capabilities/validation.capability"
import type { PartnerExtractionProfile } from "@/lib/acquisition/capabilities/consultation-capability.types"
import { catalogWarning } from "@/lib/acquisition/extraction/extraction.schema"
import {
  DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE,
  getAcquisitionAutoMinConfidence,
} from "@/lib/acquisition/policy/auto-decision-feature-flag"

const CAPABILITY_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/capabilities/validation.capability.ts"
)

function completeSnap(
  overrides: Partial<ConsultationValidationSnapshot> = {}
): ConsultationValidationSnapshot {
  return {
    worksiteName: "Chantier Galya Hall A",
    address: "12 rue de la Foire",
    city: "Lyon",
    postalCode: "69002",
    clientName: "Client Expo",
    clientEmail: "client@expo.fr",
    consultationReference: "REF-001",
    requestedStartDate: "2026-09-10",
    requestedEndDate: "2026-09-12",
    confidenceData: {
      worksiteName: 0.95,
      requestedStartDate: 0.95,
      requestedEndDate: 0.95,
    },
    warnings: [],
    ...overrides,
  }
}

function basePartner(
  overrides: Partial<PartnerExtractionProfile> = {}
): PartnerExtractionProfile {
  return {
    partnerId: "p1",
    partnerCode: "generic-partner",
    ...overrides,
  }
}

describe("PLAN-ACQ-AGENTS-LOT-2 validateConsultation", () => {
  it("1. consultation complète → PASS", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap(),
    })
    assert.equal(r.code, "PASS")
  })

  it("2. consultation update complète → PASS", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION_UPDATE",
      extractedSnapshot: completeSnap({ consultationReference: "REF-UPD-2" }),
    })
    assert.equal(r.code, "PASS")
  })

  it("3. classification null → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: null,
      extractedSnapshot: completeSnap(),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("CLASSIFICATION_NULL"))
  })

  it("4. AMBIGUOUS → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "AMBIGUOUS",
      extractedSnapshot: completeSnap(),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("CLASSIFICATION_AMBIGUOUS"))
  })

  it("5. NON_CONSULTATION → FAIL_TERMINAL", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "NON_CONSULTATION",
      extractedSnapshot: completeSnap(),
    })
    assert.equal(r.code, "FAIL_TERMINAL")
    if (r.code === "FAIL_TERMINAL") {
      assert.equal(r.errorCode, "NON_CONSULTATION")
    }
  })

  it("6. cancellation certaine → FAIL_TERMINAL (policy existante)", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CANCELLATION",
      extractedSnapshot: completeSnap({
        consultationCancelled: true,
        warnings: [catalogWarning("CONSULTATION_CANCELLED", { source: "SERVICE" })],
      }),
    })
    assert.equal(r.code, "FAIL_TERMINAL")
    if (r.code === "FAIL_TERMINAL") {
      assert.equal(r.errorCode, "CONSULTATION_CANCELLED")
    }
  })

  it("6b. CANCELLATION sans corroboration → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CANCELLATION",
      extractedSnapshot: completeSnap({ consultationCancelled: false, warnings: [] }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("CANCELLATION_UNCONFIRMED"))
  })

  it("7. faible confiance → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        confidenceData: {
          worksiteName: 0.4,
          requestedStartDate: 0.95,
          requestedEndDate: 0.95,
        },
      }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.some((x) => x.startsWith("LOW_CONFIDENCE:")))
  })

  it("8. warning bloquant → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        requiredDocumentUnreadable: true,
        warnings: [
          catalogWarning("REQUIRED_DOCUMENT_UNREADABLE", { source: "SERVICE" }),
        ],
      }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(
      r.reasons.includes("REQUIRED_DOCUMENT_UNREADABLE") ||
        r.reasons.includes("BLOCKING_WARNINGS")
    )
  })

  it("9. dates incohérentes → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        requestedStartDate: "2026-09-20",
        requestedEndDate: "2026-09-10",
      }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(
      r.reasons.includes("DATE_RANGE_INVALID") || r.reasons.includes("INVALID_DATES")
    )
  })

  it("10. duplicate_requires_ack → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({ duplicateRequiresAck: true }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("POTENTIAL_DUPLICATE"))
  })

  it("11. client ambigu → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({ clientAmbiguous: true }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("AMBIGUOUS_CLIENT"))
  })

  it("12. contenu retryable missing → FAIL_RETRYABLE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({ contentMissingRetryable: true }),
    })
    assert.equal(r.code, "FAIL_RETRYABLE")
    if (r.code === "FAIL_RETRYABLE") {
      assert.equal(r.errorCode, "CONTENT_MISSING")
    }
  })

  it("13. profil minConfidence override", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        confidenceData: {
          worksiteName: 0.8,
          requestedStartDate: 0.8,
          requestedEndDate: 0.8,
        },
      }),
      partnerProfile: basePartner({ minConfidence: 0.9 }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.some((x) => x.startsWith("LOW_CONFIDENCE:")))
  })

  it("14. aucune branche partenaire spécifique", () => {
    const src = readFileSync(CAPABILITY_SRC, "utf8")
    assert.equal(/partnerCode\s*===/.test(src), false)
    assert.equal(/partnerCode\s*==/.test(src), false)
    assert.equal(/lauralu/i.test(src), false)
    assert.equal(/hall-expo/i.test(src), false)

    const a = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap(),
      partnerProfile: basePartner({ partnerCode: "lauralu", minConfidence: 0.75 }),
    })
    const b = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap(),
      partnerProfile: basePartner({ partnerCode: "hall-expo", minConfidence: 0.75 }),
    })
    assert.equal(a.code, "PASS")
    assert.equal(b.code, "PASS")
    assert.deepEqual(a, b)
  })

  it("capability port object exposé", () => {
    const r = consultationValidationCapability.validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap(),
    })
    assert.equal(r.code, "PASS")
  })

  it("snapshot structurellement invalide → FAIL_TERMINAL", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: "not-an-object",
    })
    assert.equal(r.code, "FAIL_TERMINAL")
  })

  it("confidence invalid > 1 → QUARANTINE LOW_CONFIDENCE:worksiteName", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        confidenceData: {
          worksiteName: 999,
          requestedStartDate: 0.95,
          requestedEndDate: 0.95,
        },
      }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("LOW_CONFIDENCE:worksiteName"))
  })

  it("confidence invalid < 0 → QUARANTINE", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        confidenceData: {
          worksiteName: -1,
          requestedStartDate: 0.95,
          requestedEndDate: 0.95,
        },
      }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("LOW_CONFIDENCE:worksiteName"))
  })

  it("confidence boundary 0 → QUARANTINE (sous seuil)", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        confidenceData: {
          worksiteName: 0,
          requestedStartDate: 0.95,
          requestedEndDate: 0.95,
        },
      }),
    })
    assert.equal(r.code, "QUARANTINE")
    assert.ok(r.reasons.includes("LOW_CONFIDENCE:worksiteName"))
  })

  it("confidence boundary 1 → PASS si snapshot complet", () => {
    const r = validateConsultation({
      companyId: "c1",
      draftId: "d1",
      classification: "CONSULTATION",
      extractedSnapshot: completeSnap({
        confidenceData: {
          worksiteName: 1,
          requestedStartDate: 1,
          requestedEndDate: 1,
        },
      }),
    })
    assert.equal(r.code, "PASS")
  })

  it("default source consistency — env absent === constante", () => {
    const prev = process.env.ACQUISITION_AUTO_MIN_CONFIDENCE
    try {
      delete process.env.ACQUISITION_AUTO_MIN_CONFIDENCE
      assert.equal(
        getAcquisitionAutoMinConfidence(),
        DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE
      )
      assert.equal(DEFAULT_ACQUISITION_AUTO_MIN_CONFIDENCE, 0.75)
    } finally {
      if (prev === undefined) {
        delete process.env.ACQUISITION_AUTO_MIN_CONFIDENCE
      } else {
        process.env.ACQUISITION_AUTO_MIN_CONFIDENCE = prev
      }
    }
  })
})
