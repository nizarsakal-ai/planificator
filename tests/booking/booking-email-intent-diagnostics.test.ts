/**
 * PLAN-BOOKING-INTENT-DIAG-001 / R1 — diagnostic temporaire AMBIGU (flag BOOKING_INTENT_DIAGNOSTICS).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { classifyBookingEmailIntent } from "@/lib/booking/booking-email-intent"
import {
  buildAmbiguousIntentDiagnostic,
  extractGmailFromHeader,
  extractSenderDomainOnly,
  formatAmbiguousIntentDiagnosticLog,
  isBookingIntentDiagnosticsEnabled,
  maybeLogAmbiguousIntentDiagnostic,
  observeStructuralSignalsFromEvidence,
} from "@/lib/booking/booking-email-intent-diagnostics"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

const SENSITIVE_BODY = `
Confirmation partielle
Voyageur : Jean Dupont
Adresse : 12 rue de la Paix, 75002 Paris
Email : jean.dupont@example.com
Téléphone : +33 6 12 34 56 78
Arrivée : 15 août 2026
access_token=ya29.SECRET_ACCESS
refresh_token=1//SECRET_REFRESH
Authorization: Bearer ya29.SECRET
`

const ENV_ON = { BOOKING_INTENT_DIAGNOSTICS: "true" }
const ENV_OFF = { BOOKING_INTENT_DIAGNOSTICS: "false" }

function assertNoSensitiveLeak(line: string): void {
  assert.equal(line.includes('"subject"'), false)
  assert.equal(line.includes("subject"), false)
  assert.equal(line.includes(SENSITIVE_BODY), false)
  assert.equal(line.includes("Jean Dupont"), false)
  assert.equal(line.includes("12 rue de la Paix"), false)
  assert.equal(line.includes("+33 6 12 34 56 78"), false)
  assert.equal(line.includes("jean.dupont@example.com"), false)
  assert.equal(line.includes("ya29.SECRET_ACCESS"), false)
  assert.equal(line.includes("1//SECRET_REFRESH"), false)
  assert.equal(line.includes("Authorization"), false)
  assert.equal(line.includes("access_token"), false)
  assert.equal(line.includes("refresh_token"), false)
  assert.equal(line.includes("<html"), false)
  assert.equal(line.includes("</html>"), false)
}

describe("isBookingIntentDiagnosticsEnabled", () => {
  it("true uniquement si BOOKING_INTENT_DIAGNOSTICS=true", () => {
    assert.equal(isBookingIntentDiagnosticsEnabled({}), false)
    assert.equal(isBookingIntentDiagnosticsEnabled({ BOOKING_INTENT_DIAGNOSTICS: "" }), false)
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

  it("From absent/malformé → fail-safe null", () => {
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

describe("diagnostics désactivés → aucun log, coût minimal", () => {
  it("flag OFF → aucun log et getFromHeaderValue jamais appelé", () => {
    const classification = classifyBookingEmailIntent({
      subject: "Votre séjour",
      bodyText: SENSITIVE_BODY,
    })
    assert.equal(classification.intent, "AMBIGU")

    let fromCalls = 0
    const lines: string[] = []
    const logged = maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "msg-1",
        companyId: "co-1",
        classification,
        getFromHeaderValue: () => {
          fromCalls++
          return "Booking <noreply@booking.com>"
        },
      },
      { env: ENV_OFF, logFn: (line) => lines.push(line) }
    )
    assert.equal(logged, false)
    assert.equal(lines.length, 0)
    assert.equal(fromCalls, 0)
  })

  it("flag absent → aucun log, From non extrait", () => {
    const classification = classifyBookingEmailIntent({
      subject: "Confirmation de réservation",
      bodyText: "Numéro de réservation : 1234.567.890",
    })
    assert.equal(classification.intent, "AMBIGU")

    let fromCalls = 0
    const lines: string[] = []
    maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "m",
        companyId: "c",
        classification,
        getFromHeaderValue: () => {
          fromCalls++
          return "x@y.com"
        },
      },
      { env: {}, logFn: (l) => lines.push(l) }
    )
    assert.equal(lines.length, 0)
    assert.equal(fromCalls, 0)
  })
})

describe("diagnostics activés → logs supplémentaires uniquement", () => {
  it("AMBIGU + flag ON → un log structuré sans subject", () => {
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
        classification: ambigu,
        getFromHeaderValue: () => "Booking.com <noreply@booking.com>",
      },
      { env: ENV_ON, logFn: (line) => lines.push(line) }
    )
    assert.equal(logged, true)
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /^\[booking-intent-diag\] /)

    const payload = JSON.parse(lines[0]!.slice("[booking-intent-diag] ".length))
    assert.equal(payload.messageId, "gmail-abc")
    assert.equal(payload.companyId, "company-xyz")
    assert.equal(payload.senderDomain, "booking.com")
    assert.equal(payload.finalDecision, "AMBIGU")
    assert.ok(Array.isArray(payload.evidence))
    assert.equal(typeof payload.structuralScore, "number")
    assert.equal(payload.confidence, "low")
    assert.equal(typeof payload.decisionPath, "string")
    assert.ok(Array.isArray(payload.observedStructuralSignals))
    assert.ok(Array.isArray(payload.missingObservedStructuralSignals))
    assert.equal("subject" in payload, false)
    assert.equal("missingSignalsPreventingConfirmation" in payload, false)
    assertNoSensitiveLeak(lines[0]!)
  })

  it("CONFIRMATION → aucun diagnostic même flag ON ; From non extrait", () => {
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

    let fromCalls = 0
    const lines: string[] = []
    const logged = maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "gmail-ok",
        companyId: "company-xyz",
        classification: confirmation,
        getFromHeaderValue: () => {
          fromCalls++
          return "Booking.com <noreply@booking.com>"
        },
      },
      { env: ENV_ON, logFn: (line) => lines.push(line) }
    )
    assert.equal(logged, false)
    assert.equal(lines.length, 0)
    assert.equal(fromCalls, 0)
  })

  it("MESSAGE_ETABLISSEMENT → aucun log diagnostic", () => {
    const r = classifyBookingEmailIntent({
      subject: "Nouveau message",
      bodyText: "Vous avez un nouveau message de l'établissement.",
    })
    assert.equal(r.intent, "MESSAGE_ETABLISSEMENT")
    let fromCalls = 0
    const lines: string[] = []
    assert.equal(
      maybeLogAmbiguousIntentDiagnostic(
        {
          messageId: "m-host",
          companyId: "c",
          classification: r,
          getFromHeaderValue: () => {
            fromCalls++
            return "x@y.com"
          },
        },
        { env: ENV_ON, logFn: (l) => lines.push(l) }
      ),
      false
    )
    assert.equal(lines.length, 0)
    assert.equal(fromCalls, 0)
  })

  it("ANNULATION / cancellation → aucun log diagnostic", () => {
    const r = classifyBookingEmailIntent({
      subject: "Annulation",
      bodyText: `
Votre réservation a été annulée.
Numéro de réservation : 1234.567.890
Établissement : Test
Adresse : 1 rue Test
Arrivée : 1 janvier 2026
Départ : 2 janvier 2026
`,
    })
    assert.equal(r.intent, "ANNULATION")
    const lines: string[] = []
    assert.equal(
      maybeLogAmbiguousIntentDiagnostic(
        {
          messageId: "m-cancel",
          companyId: "c",
          classification: r,
          getFromHeaderValue: () => "x@y.com",
        },
        { env: ENV_ON, logFn: (l) => lines.push(l) }
      ),
      false
    )
    assert.equal(lines.length, 0)
  })

  it("RECU / receipt → aucun log diagnostic", () => {
    const r = classifyBookingEmailIntent({
      subject: "Your Booking.com receipt",
      bodyText: `
Here's your receipt
Numéro de réservation : 1
Payment receipt total: $320
`,
    })
    assert.equal(r.intent, "RECU")
    const lines: string[] = []
    assert.equal(
      maybeLogAmbiguousIntentDiagnostic(
        {
          messageId: "m-receipt",
          companyId: "c",
          classification: r,
          getFromHeaderValue: () => "x@y.com",
        },
        { env: ENV_ON, logFn: (l) => lines.push(l) }
      ),
      false
    )
    assert.equal(lines.length, 0)
  })

  it("AUTRE_PROUVE / OTHER → aucun log diagnostic", () => {
    const r = classifyBookingEmailIntent({
      subject: "Offre spéciale Booking",
      bodyText: "Découvrez nos destinations Genius et gagnez des Genius rewards",
    })
    assert.equal(r.intent, "AUTRE_PROUVE")
    const lines: string[] = []
    assert.equal(
      maybeLogAmbiguousIntentDiagnostic(
        {
          messageId: "m-other",
          companyId: "c",
          classification: r,
          getFromHeaderValue: () => "x@y.com",
        },
        { env: ENV_ON, logFn: (l) => lines.push(l) }
      ),
      false
    )
    assert.equal(lines.length, 0)
  })

  it("decisionPath reflète ambig:* evidence (déterministe)", () => {
    assert.equal(
      observeStructuralSignalsFromEvidence([
        "ambig:lexicon_without_structure",
      ]).decisionPath,
      "lexicon_without_structure"
    )
    assert.equal(
      observeStructuralSignalsFromEvidence([
        "struct:booking_ref",
        "ambig:partial_structure",
      ]).decisionPath,
      "partial_structure_ref_without_dates"
    )
    assert.equal(
      observeStructuralSignalsFromEvidence(["ambig:no_decisive_signal"])
        .decisionPath,
      "no_decisive_signal"
    )
  })

  it("observation structurelle descriptive sans seuils métier", () => {
    const o = observeStructuralSignalsFromEvidence([
      "struct:dates",
      "struct:property",
      "ambig:no_decisive_signal",
    ])
    assert.deepEqual(o.observedStructuralSignals, [
      "struct:dates",
      "struct:property",
    ])
    assert.deepEqual(o.missingObservedStructuralSignals, [
      "struct:booking_ref",
      "struct:address",
    ])
    assert.equal(o.structuralScore, 2)
    // Pas de codes métier recalculés
    assert.equal(
      JSON.stringify(o).includes("need_structural_score"),
      false
    )
    assert.equal(JSON.stringify(o).includes("PreventingConfirmation"), false)
  })
})

describe("aucune donnée sensible dans les logs", () => {
  it("ne contient pas subject, body, email, tél, adresse, nom, tokens", () => {
    const classification = classifyBookingEmailIntent({
      subject: "Confirmation Jean Dupont — 12 rue de la Paix — +33 6 12 34 56 78",
      bodyText: SENSITIVE_BODY,
    })
    assert.equal(classification.intent, "AMBIGU")

    const fromHeader = "Jean Dupont <jean.dupont@secret-mail.example>"
    const diagnostic = buildAmbiguousIntentDiagnostic({
      messageId: "msg-sens",
      companyId: "co-sens",
      senderDomain: extractSenderDomainOnly(fromHeader),
      classification,
    })
    assert.ok(diagnostic)
    assert.equal(diagnostic!.senderDomain, "secret-mail.example")
    assert.equal("subject" in diagnostic!, false)

    const line = formatAmbiguousIntentDiagnosticLog(diagnostic!)
    assertNoSensitiveLeak(line)
    assert.equal(line.includes("jean.dupont@secret-mail.example"), false)
    assert.equal(line.includes("jean.dupont@"), false)
    assert.equal(line.includes(fromHeader), false)
    assert.equal(line.includes("secret-mail.example"), true)
    assert.match(line, /"senderDomain":"secret-mail\.example"/)

    // Sujet PII jamais dans le payload même s'il était fourni au classifieur
    assert.equal(line.includes("Confirmation Jean Dupont"), false)
    assert.equal(line.includes("+33 6 12 34 56 78"), false)
  })

  it("clés diagnostic sans subject / body / from / email", () => {
    const classification = classifyBookingEmailIntent({
      subject: "Infos séjour",
      bodyText: SENSITIVE_BODY,
    })
    const d = buildAmbiguousIntentDiagnostic({
      messageId: "m",
      companyId: "c",
      senderDomain: "x.com",
      classification,
    })
    assert.ok(d)
    const keys = Object.keys(d!)
    assert.equal(keys.includes("subject"), false)
    assert.equal(keys.includes("body"), false)
    assert.equal(keys.includes("bodyText"), false)
    assert.equal(keys.includes("from"), false)
    assert.equal(keys.includes("email"), false)
    assert.equal(keys.includes("missingSignalsPreventingConfirmation"), false)
  })
})

describe("classification inchangée (pas d'effet de bord métier)", () => {
  it("même entrée → même résultat avant/après appel diagnostic", () => {
    const input = {
      subject: "Confirmation de réservation",
      bodyText: "Numéro de réservation : 1234.567.890",
    }
    const a = classifyBookingEmailIntent(input)
    maybeLogAmbiguousIntentDiagnostic(
      {
        messageId: "m",
        companyId: "c",
        classification: a,
        getFromHeaderValue: () => "x@y.com",
      },
      { env: ENV_ON, logFn: () => {} }
    )
    const b = classifyBookingEmailIntent(input)
    assert.deepEqual(a, b)
  })
})

describe("wiring source gmail-scan", () => {
  it("route utilise getFromHeaderValue (lazy) + maybeLog", () => {
    const route = readFileSync(
      join(ROOT, "src/app/api/cron/gmail-scan/route.ts"),
      "utf8"
    )
    assert.match(route, /maybeLogAmbiguousIntentDiagnostic/)
    assert.match(route, /getFromHeaderValue/)
    assert.match(route, /extractGmailFromHeader/)
    assert.match(route, /booking-email-intent-diagnostics/)
    // Pas de passage de subject au diagnostic
    assert.equal(
      /maybeLogAmbiguousIntentDiagnostic\(\{[\s\S]*?subject[\s\S]*?\}\)/.test(
        route
      ),
      false
    )
  })
})
