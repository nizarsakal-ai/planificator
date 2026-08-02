/**
 * PLAN-BOOKING-UX-002 R1+ — Complétude : créabilité ≠ identité pending.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  evaluatePendingCompleteness,
  hasPendingIdentityLabel,
  isPendingReady,
  resolveConfirmAccommodationAddress,
} from "@/lib/booking/booking-pending-ready"
import { resolveConfirmAddress } from "@/lib/booking/booking-pending-merge"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

const DATES = {
  startDate: "2026-09-01",
  endDate: "2026-09-03",
}

describe("PLAN-BOOKING-UX-002 R1 — evaluatePendingCompleteness", () => {
  it("adresse + dates + équipe, sans secondaires → PRÊT et créable", () => {
    const r = evaluatePendingCompleteness({
      propertyName: null,
      address: "12 rue de la Paix",
      city: null,
      zipCode: null,
      contactPhone: null,
      contactName: null,
      doorCode: null,
      notes: null,
      ...DATES,
      teamId: "t1",
    })
    assert.equal(r.status, "READY")
    assert.equal(r.canCreate, true)
    assert.equal(r.canValidate, true)
    assert.equal(r.hint, null)
    assert.ok(r.missingOptional.includes("ville"))
    assert.ok(r.missingOptional.includes("téléphone"))
  })

  it("nom seul sans adresse → ACTION REQUISE, non créable", () => {
    const r = evaluatePendingCompleteness({
      propertyName: "Appart Centre",
      address: null,
      ...DATES,
      teamId: "t1",
    })
    assert.equal(r.status, "ACTION_REQUIRED")
    assert.equal(r.canCreate, false)
    assert.equal(r.canValidate, false)
    assert.ok(r.missingRequired.includes("adresse"))
    assert.match(r.hint ?? "", /adresse/)
    assert.equal(r.hasIdentityLabel, true)
  })

  it("adresse présente sans nom → créable / PRÊT", () => {
    const r = evaluatePendingCompleteness({
      propertyName: null,
      address: "10 rue Min",
      ...DATES,
      teamId: "team-1",
    })
    assert.equal(r.canCreate, true)
    assert.equal(r.canValidate, true)
    assert.equal(r.status, "READY")
    assert.ok(r.missingOptional.includes("nom logement"))
  })

  it("dates manquantes → ACTION REQUISE", () => {
    assert.equal(
      evaluatePendingCompleteness({
        address: "10 rue A",
        startDate: null,
        endDate: "2026-09-03",
        teamId: "t1",
      }).status,
      "ACTION_REQUIRED"
    )
    assert.equal(
      evaluatePendingCompleteness({
        address: "10 rue A",
        startDate: "2026-09-01",
        endDate: null,
        teamId: "t1",
      }).status,
      "ACTION_REQUIRED"
    )
  })

  it("équipe manquante → badge PRÊT, bouton bloqué (aligné banner)", () => {
    const withTeamScope = evaluatePendingCompleteness({
      address: "10 rue A",
      ...DATES,
      teamId: "",
    })
    assert.equal(withTeamScope.status, "READY")
    assert.equal(withTeamScope.canCreate, true)
    assert.equal(withTeamScope.canValidate, false)
    assert.match(withTeamScope.hint ?? "", /équipe/)

    const bannerLike = evaluatePendingCompleteness({
      address: "10 rue A",
      ...DATES,
    })
    assert.equal(bannerLike.status, "READY")
    assert.equal(bannerLike.canCreate, true)
  })

  it("secondaires absents ne basculent pas en À VÉRIFIER", () => {
    const r = evaluatePendingCompleteness({
      address: "1 rue A",
      city: null,
      zipCode: null,
      doorCode: null,
      contactName: null,
      contactPhone: null,
      notes: null,
      ...DATES,
      teamId: "t1",
    })
    assert.equal(r.status, "READY")
  })

  it("dates incohérentes → À VÉRIFIER, bouton et création bloqués", () => {
    const incoherent = evaluatePendingCompleteness({
      address: "1 rue A",
      startDate: "2026-09-10",
      endDate: "2026-09-01",
      teamId: "t1",
    })
    assert.equal(incoherent.status, "NEEDS_REVIEW")
    assert.equal(incoherent.canCreate, false)
    assert.equal(incoherent.canValidate, false)
    assert.match(incoherent.hint ?? "", /dates/)
  })

  it("requiresHumanReview → À VÉRIFIER mais créable", () => {
    const flagged = evaluatePendingCompleteness({
      address: "1 rue A",
      ...DATES,
      teamId: "t1",
      requiresHumanReview: true,
    })
    assert.equal(flagged.status, "NEEDS_REVIEW")
    assert.equal(flagged.canCreate, true)
    assert.equal(flagged.canValidate, true)
  })

  it("espaces seuls dans address / propertyName → absents", () => {
    const ws = evaluatePendingCompleteness({
      propertyName: "   ",
      address: "  \t  ",
      ...DATES,
      teamId: "t1",
    })
    assert.equal(ws.status, "ACTION_REQUIRED")
    assert.ok(ws.missingRequired.includes("adresse"))
    assert.equal(ws.hasIdentityLabel, false)
    assert.equal(resolveConfirmAddress("   ", "  "), null)
    assert.equal(
      resolveConfirmAccommodationAddress({ address: "   ", overrideAddress: " " }),
      null
    )
  })

  it("identité pending ≠ créabilité", () => {
    assert.equal(
      hasPendingIdentityLabel({ propertyName: "Only Name", address: null }),
      true
    )
    assert.equal(
      isPendingReady({
        propertyName: "Only Name",
        address: null,
        ...DATES,
      }),
      false
    )
    assert.equal(
      isPendingReady({
        propertyName: null,
        address: "12 rue X",
        ...DATES,
      }),
      true
    )
  })

  it("aucun fallback propertyName → address", () => {
    assert.equal(
      resolveConfirmAccommodationAddress({
        address: null,
        overrideAddress: undefined,
      }),
      null
    )
    assert.equal(resolveConfirmAddress(null, undefined), null)
    assert.equal(
      resolveConfirmAccommodationAddress({
        address: "12 rue Z",
      }),
      "12 rue Z"
    )
    const readySrc = readFileSync(
      join(ROOT, "src/lib/booking/booking-pending-ready.ts"),
      "utf8"
    )
    const mergeSrc = readFileSync(
      join(ROOT, "src/lib/booking/booking-pending-merge.ts"),
      "utf8"
    )
    const confirmSrc = readFileSync(
      join(ROOT, "src/lib/actions/gmail-pending-confirm.core.ts"),
      "utf8"
    )
    assert.equal(readySrc.includes("nonEmpty(input.propertyName)"), false)
    assert.equal(mergeSrc.includes("nonEmpty(propertyName)"), false)
    assert.equal(confirmSrc.includes("propertyName: pending.propertyName"), false)
    assert.ok(confirmSrc.includes("resolveConfirmAddress(pending.address"))
  })
})

describe("PLAN-BOOKING-UX-002 R1 — garde-fous non-régression", () => {
  it("UI : complétude + messages bloquants ; confirm Gmail intact", () => {
    const dialog = readFileSync(
      join(ROOT, "src/components/logements/PendingBookingsDialog.tsx"),
      "utf8"
    )
    const banner = readFileSync(
      join(ROOT, "src/components/logements/PendingBookingsBanner.tsx"),
      "utf8"
    )
    const core = readFileSync(
      join(ROOT, "src/lib/actions/gmail-pending-confirm.core.ts"),
      "utf8"
    )
    assert.ok(dialog.includes("evaluatePendingCompleteness"))
    assert.ok(dialog.includes("Valider et créer"))
    assert.ok(dialog.includes("Adresse manquante"))
    assert.equal(dialog.includes('"Incomplet"'), false)
    assert.ok(banner.includes("À vérifier"))
    assert.ok(banner.includes("Action requise"))
    assert.ok(banner.includes('action\n              {actionRequiredCount > 1 ? "s" : ""} requise'))
    assert.ok(core.includes("accommodationFieldsFromPendingIdentity"))
    assert.ok(core.includes("runConfirmCreateTransaction"))
    assert.ok(core.includes('Veuillez saisir l\'adresse du logement.'))
  })
})
