/**
 * PLAN-BOOKING-INTENT-DIAG-001 — diagnostic temporaire AMBIGU (flag BOOKING_INTENT_DIAGNOSTICS).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { classifyBookingEmailIntent } from "@/lib/booking/booking-email-intent"
import {
  buildAmbiguousIntentDiagnostic,
  deriveAmbiguousGapFromEvidence,
  extractGmailFromHeader,
  extractSenderDomainOnly,
  formatAmbiguousIntentDiagnosticLog,
  isBookingIntentDiagnosticsEnabled,
  maybeLogAmbiguousIntentDiagnostic,
  truncateSubjectForDiagnosticLog,
} from "@/lib/booking/booking-email-intent-diagnostics"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

const SENSITIVE_BODY = `
Confirmation partielle
Voyageur : Jean Dupont
Adresse : 12 rue de la Paix, 75002 Paris
Email : jean.dupont@example.com
Téléphone : +33 6 12 34 56 78
Arrivée : 15 août 2026
`

describe("isBookingIntentDiagnosticsEnabled", () => {
  it("true uniquement si BOOKING_INTENT_DIAGNOSTICS=true", () => {
    assert.equal(isBookingIntentDiagnosticsEnabled({}), false)
    assert.equal(
      isBookingIntentDiagnosticsEnabled({ BOOKING_INTENT_DIAGNOSTICS: "false" }),
      false
    )
    assert.equal(
      isBookingIntentDiagnosticsEnabled({ BOOKING_INTENT_DIAGNOSTICS: "1" }),
      false
    )
    assert.equal(
      isBookingIntentDiagnosticsEnabled({ BOOKING_INTENT_DIAGNOSTICS: "true" }),
      true
    )
  })
})

describe("extractSenderDomainOnly — jamais d'email complet", () => {
  it("Name <user@domain> → domain", () => {
    assert.equal(
      extractSenderDomainOnly("Booking.com <noreply@booking.com>"),
      "booking.com"
    )
  })

  it("adresse nue → domain", () => {
    assert.equal(extractSenderDomainOnly("noreply@airbnb.com"), "airbnb.com")
  })

  it("malformé → null", () => {
    assert.equal(extractSenderDomainOnly(""), null)
    assert.equal(extractSenderDomainOnly("not-an-email"), null)
    assert.equal(extractSenderDomainOnly("<>"), null)
  })
})

describe("extractGmailFromHeader", () => {
  it("lit header From (insensible à la casse)", () => {
    assert.equal(
      extractGmailFromHeader({
        headers: [
          { name: "Subject", value: "Hello" },
          { name: "From", value: "Host <host@hotel.example>" },
        ],
      }),
      "Host <host@hotel.example>"
    )
  })
})

describe("diagnostics désactivés → aucun log, classifieur inchangé", () => {
  it("maybeLog ne log rien si flag off", () => {
    const classification = classifyBookingEmailIntent({
      subject: "Votre séjour",
      bodyText: SENSITIVE_BODY,
    })
    assert.equal(classification.intent, "AMBIGU")

    const lines: string[] = []
    const logged = maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "msg-1",
        companyId: "co-1",
        fromHeaderValue: "Booking <noreply@booking.com>",
        subject: "Votre séjour",
        classification,
      },
      {
        env: { BOOKING_INTENT_DIAGNOSTICS: "false" },
        logFn: (line) => lines.push(line),
      }
    )
    assert.equal(logged, false)
    assert.equal(lines.length, 0)
  })

  it("classification identique avec/sans diagnostic (pas d'effet de bord)", () => {
    const a = classifyBookingEmailIntent({
      subject: "Confirmation de réservation",
      bodyText: "Numéro de réservation : 1234.567.890",
    })
    const b = classifyBookingEmailIntent({
      subject: "Confirmation de réservation",
      bodyText: "Numéro de réservation : 1234.567.890",
    })
    assert.deepEqual(a, b)
    assert.equal(a.intent, "AMBIGU")

    const lines: string[] = []
    maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "m",
        companyId: "c",
        fromHeaderValue: "x@y.com",
        subject: "Confirmation de réservation",
        classification: a,
      },
      { env: {}, logFn: (l) => lines.push(l) }
    )
    assert.equal(lines.length, 0)
    assert.deepEqual(
      classifyBookingEmailIntent({
        subject: "Confirmation de réservation",
        bodyText: "Numéro de réservation : 1234.567.890",
      }),
      a
    )
  })
})

describe("diagnostics activés → logs supplémentaires uniquement", () => {
  it("AMBIGU → un log structuré ; CONFIRMATION → aucun", () => {
    const ambigu = classifyBookingEmailIntent({
      subject: "Votre séjour",
      bodyText: "Arrivée : 15 août 2026 Départ : 18 août 2026",
    })
    assert.equal(ambigu.intent, "AMBIGU")

    const lines: string[] = []
    const logged = maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "gmail-abc",
        companyId: "company-xyz",
        fromHeaderValue: "Booking.com <noreply@booking.com>",
        subject: "Votre séjour",
        classification: ambigu,
      },
      {
        env: { BOOKING_INTENT_DIAGNOSTICS: "true" },
        logFn: (line) => lines.push(line),
      }
    )
    assert.equal(logged, true)
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /^\[booking-intent-diag\] /)

    const payload = JSON.parse(lines[0]!.slice("[booking-intent-diag] ".length))
    assert.equal(payload.messageId, "gmail-abc")
    assert.equal(payload.companyId, "company-xyz")
    assert.equal(payload.senderDomain, "booking.com")
    assert.equal(payload.subject, "Votre séjour")
    assert.equal(payload.finalDecision, "AMBIGU")
    assert.ok(Array.isArray(payload.evidence))
    assert.equal(typeof payload.structuralScore, "number")
    assert.equal(payload.confidence, "low")
    assert.ok(Array.isArray(payload.structuralSignalsPresent))
    assert.ok(Array.isArray(payload.missingSignalsPreventingConfirmation))
    assert.equal(typeof payload.decisionPath, "string")

    const confirmation = classifyBookingEmailIntent({
      subject: "Confirmation de réservation",
      bodyText: `
Confirmation de réservation
Numéro de réservation : 1234.567.890
Établissement : Appartement Lumière
Adresse : 12 rue de la Paix, 75002 Paris
Arrivée : 15 août 2026
Départ : 18 août 2026
`,
    })
    assert.equal(confirmation.intent, "CONFIRMATION")

    const lines2: string[] = []
    const logged2 = maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "gmail-ok",
        companyId: "company-xyz",
        fromHeaderValue: "Booking.com <noreply@booking.com>",
        subject: "Confirmation de réservation",
        classification: confirmation,
      },
      {
        env: { BOOKING_INTENT_DIAGNOSTICS: "true" },
        logFn: (line) => lines2.push(line),
      }
    )
    assert.equal(logged2, false)
    assert.equal(lines2.length, 0)
  })

  it("decisionPath reflète ambig:* evidence", () => {
    assert.equal(
      deriveAmbiguousGapFromEvidence(["ambig:lexicon_without_structure"]).decisionPath,
      "lexicon_without_structure"
    )
    assert.equal(
      deriveAmbiguousGapFromEvidence([
        "struct:booking_ref",
        "ambig:partial_structure",
      ]).decisionPath,
      "partial_structure_ref_without_dates"
    )
    assert.equal(
      deriveAmbiguousGapFromEvidence(["ambig:no_decisive_signal"]).decisionPath,
      "no_decisive_signal"
    )
  })
})

describe("aucune donnée sensible dans les logs", () => {
  it("ne contient pas email complet, téléphone, adresse, nom, corps", () => {
    const classification = classifyBookingEmailIntent({
      subject: "Infos séjour",
      bodyText: SENSITIVE_BODY,
    })
    assert.equal(classification.intent, "AMBIGU")

    const fromHeader = "Jean Dupont <jean.dupont@secret-mail.example>"
    const diagnostic = buildAmbiguousIntentDiagnostic({
      messageId: "msg-sens",
      companyId: "co-sens",
      senderDomain: extractSenderDomainOnly(fromHeader),
      subject: "Infos séjour",
      classification,
    })
    assert.ok(diagnostic)
    assert.equal(diagnostic!.senderDomain, "secret-mail.example")

    const line = formatAmbiguousIntentDiagnosticLog(diagnostic!)

    // Email complet / local-part
    assert.equal(line.includes("jean.dupont@secret-mail.example"), false)
    assert.equal(line.includes("jean.dupont@"), false)
    assert.equal(line.includes(fromHeader), false)

    // PII du corps
    assert.equal(line.includes("Jean Dupont"), false)
    assert.equal(line.includes("12 rue de la Paix"), false)
    assert.equal(line.includes("+33 6 12 34 56 78"), false)
    assert.equal(line.includes("jean.dupont@example.com"), false)
    assert.equal(line.includes(SENSITIVE_BODY), false)

    // Domaine seul OK
    assert.equal(line.includes("secret-mail.example"), true)
    assert.match(line, /"senderDomain":"secret-mail\.example"/)
  })

  it("sujet tronqué si trop long ; pas de body dans build", () => {
    const long = "A".repeat(400)
    assert.equal(truncateSubjectForDiagnosticLog(long).length, 301)
    assert.ok(truncateSubjectForDiagnosticLog(long).endsWith("…"))

    const classification = classifyBookingEmailIntent({
      subject: long,
      bodyText: SENSITIVE_BODY,
    })
    const d = buildAmbiguousIntentDiagnostic({
      messageId: "m",
      companyId: "c",
      senderDomain: "x.com",
      subject: long,
      classification,
    })
    assert.ok(d)
    assert.ok(d!.subject.length <= 301)
    const keys = Object.keys(d!)
    assert.equal(keys.includes("body"), false)
    assert.equal(keys.includes("bodyText"), false)
    assert.equal(keys.includes("from"), false)
    assert.equal(keys.includes("email"), false)
  })
})

describe("wiring source gmail-scan", () => {
  it("route importe maybeLogAmbiguousIntentDiagnostic", () => {
    const route = readFileSync(
      join(ROOT, "src/app/api/cron/gmail-scan/route.ts"),
      "utf8"
    )
    assert.match(route, /maybeLogAmbiguousIntentDiagnostic/)
    assert.match(route, /extractGmailFromHeader/)
    assert.match(route, /booking-email-intent-diagnostics/)
  })
})
