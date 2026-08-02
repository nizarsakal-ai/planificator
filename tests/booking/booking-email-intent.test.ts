/**
 * PLAN-BOOKING-PARSER-003 — classifieur + gate réel (chemin gmail-scan).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import {
  BOOKING_INTENT_IGNORE_CODES,
  classifyBookingEmailIntent,
  extractGmailSubject,
  resolveBookingIntentScanDisposition,
  type BookingEmailClassification,
} from "@/lib/booking/booking-email-intent"
import { applyBookingEmailIntentGate } from "@/lib/booking/booking-email-intent-gate"
import {
  classifyBookingError,
  permanentBookingError,
  retryableBookingError,
} from "@/lib/booking/booking-gmail-errors"
import {
  BookingGmailMessageLifecycle,
  getBookingGmailMaxAttempts,
} from "@/lib/booking/gmail-message-lifecycle"
import type {
  BookingGmailMessageStatus,
  BookingGmailResultType,
  ProcessedGmailMessage,
} from "@prisma/client"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

const CONFIRMATION_BODY_FR = `
Confirmation de réservation
Numéro de réservation : 1234.567.890
Établissement : Appartement Lumière
Adresse : 12 rue de la Paix, 75002 Paris, France
Arrivée : 15 août 2026
Départ : 18 août 2026
Téléphone : +33 1 23 45 67 89
Digicode : 4521#
`

const CONFIRMATION_BODY_EN = `
Booking confirmation
Confirmation number: 99887766
Property: Harbour View Flat
Address: 42 Queen Street, Edinburgh EH2 1JX, United Kingdom
Check-in: 2026-09-01
Check-out: 2026-09-05
Phone: +44 131 000 0000
Access code: 7788
`

type Row = ProcessedGmailMessage

function createFakeLifecycleDb(): {
  api: NonNullable<ConstructorParameters<typeof BookingGmailMessageLifecycle>[0]>
  rows: Map<string, Row>
} {
  const rows = new Map<string, Row>()
  const key = (companyId: string, messageId: string) => `${companyId}::${messageId}`

  const api = {
    processedGmailMessage: {
      async create({ data }: { data: Partial<Row> & { companyId: string; messageId: string } }) {
        const k = key(data.companyId, data.messageId)
        if (rows.has(k)) {
          const err = Object.assign(new Error("Unique"), { code: "P2002" })
          throw err
        }
        const row: Row = {
          id: `id_${rows.size + 1}`,
          companyId: data.companyId,
          messageId: data.messageId,
          processedAt: data.processedAt ?? new Date(),
          status: (data.status as BookingGmailMessageStatus) ?? "PROCESSING",
          attemptCount: data.attemptCount ?? 1,
          firstAttemptAt: data.firstAttemptAt ?? new Date(),
          lastAttemptAt: data.lastAttemptAt ?? new Date(),
          nextRetryAt: data.nextRetryAt ?? null,
          succeededAt: data.succeededAt ?? null,
          errorCode: data.errorCode ?? null,
          errorMessage: data.errorMessage ?? null,
          resultType: (data.resultType as BookingGmailResultType) ?? null,
          resultEntityId: data.resultEntityId ?? null,
          updatedAt: new Date(),
        }
        rows.set(k, row)
        return { ...row }
      },
      async findUnique({
        where,
      }: {
        where: { id?: string; companyId_messageId?: { companyId: string; messageId: string } }
      }) {
        if (where.id) {
          for (const r of rows.values()) if (r.id === where.id) return { ...r }
          return null
        }
        const ck = where.companyId_messageId!
        return rows.has(key(ck.companyId, ck.messageId))
          ? { ...rows.get(key(ck.companyId, ck.messageId))! }
          : null
      },
      async findUniqueOrThrow(args: {
        where: { id?: string; companyId_messageId?: { companyId: string; messageId: string } }
      }) {
        const r = await api.processedGmailMessage.findUnique(args)
        if (!r) throw new Error("Not found")
        return r
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) {
        let count = 0
        for (const [k, row] of rows) {
          if (where.id && row.id !== where.id) continue
          if (where.companyId && row.companyId !== where.companyId) continue
          if (where.messageId && row.messageId !== where.messageId) continue
          if (where.status && row.status !== where.status) continue
          if (
            where.attemptCount !== undefined &&
            row.attemptCount !== where.attemptCount
          ) {
            continue
          }
          const next: Row = { ...row }
          for (const [field, value] of Object.entries(data)) {
            if (
              typeof value === "object" &&
              value &&
              "increment" in (value as object)
            ) {
              ;(next as unknown as Record<string, number>)[field] =
                Number((next as unknown as Record<string, number>)[field] ?? 0) +
                (value as { increment: number }).increment
            } else {
              ;(next as unknown as Record<string, unknown>)[field] = value
            }
          }
          next.updatedAt = new Date()
          rows.set(k, next)
          count++
        }
        return { count }
      },
    },
  }

  return {
    api: api as unknown as NonNullable<
      ConstructorParameters<typeof BookingGmailMessageLifecycle>[0]
    >,
    rows,
  }
}

describe("extractGmailSubject", () => {
  it("lit le header Subject réel, pas le snippet", () => {
    assert.equal(
      extractGmailSubject({
        headers: [
          { name: "From", value: "noreply@booking.com" },
          { name: "Subject", value: " Confirmation de réservation " },
        ],
      }),
      "Confirmation de réservation"
    )
    assert.equal(extractGmailSubject({ headers: [] }), "")
    assert.equal(extractGmailSubject(null), "")
    assert.equal(
      extractGmailSubject({
        headers: [{ name: "subject", value: "Booking confirmation" }],
      }),
      "Booking confirmation"
    )
  })
})

describe("classifyBookingEmailIntent — CONFIRMATION", () => {
  it("1. sujet confirmation + corps structuré → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Confirmation de réservation — Booking.com",
      bodyText: CONFIRMATION_BODY_FR,
    })
    assert.equal(r.intent, "CONFIRMATION")
  })

  it("2. sujet générique + corps structuré → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Booking.com",
      bodyText: `
Numéro de réservation : ABCD1234
Établissement : Villa Mer
Adresse : 5 chemin des Pins
Arrivée : 2026-10-01
Départ : 2026-10-04
`,
    })
    assert.equal(r.intent, "CONFIRMATION")
  })

  it("3. confirmation EN → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Your booking is confirmed",
      bodyText: CONFIRMATION_BODY_EN,
    })
    assert.equal(r.intent, "CONFIRMATION")
  })

  it("collision: confirmation + CTA View messages → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Booking confirmation",
      bodyText: `${CONFIRMATION_BODY_EN}\nView messages`,
    })
    assert.equal(r.intent, "CONFIRMATION")
  })

  it("collision: confirmation + Invoice available footer → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Your booking is confirmed",
      bodyText: `${CONFIRMATION_BODY_EN}\nInvoice available for download`,
    })
    assert.equal(r.intent, "CONFIRMATION")
    assert.ok(r.evidence.includes("weak:receipt_cta"))
  })

  it("collision: confirmation + Download your Booking invoice → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Booking confirmation",
      bodyText: `${CONFIRMATION_BODY_EN}\nDownload your Booking invoice`,
    })
    assert.equal(r.intent, "CONFIRMATION")
    assert.ok(r.evidence.includes("weak:receipt_cta"))
  })

  it("collision: confirmation + Payment invoice available → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Your booking is confirmed",
      bodyText: `${CONFIRMATION_BODY_EN}\nPayment invoice available`,
    })
    assert.equal(r.intent, "CONFIRMATION")
    assert.ok(r.evidence.includes("weak:receipt_cta"))
  })

  it("collision: confirmation + Download your payment receipt → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Booking confirmation",
      bodyText: `${CONFIRMATION_BODY_EN}\nDownload your payment receipt`,
    })
    assert.equal(r.intent, "CONFIRMATION")
    assert.ok(r.evidence.includes("weak:receipt_cta"))
  })

  it("collision: confirmation + Télécharger votre facture Booking → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Confirmation de réservation",
      bodyText: `${CONFIRMATION_BODY_FR}\nTélécharger votre facture Booking`,
    })
    assert.equal(r.intent, "CONFIRMATION")
    assert.ok(r.evidence.includes("weak:receipt_cta"))
  })

  it("collision: confirmation + mention facture footer FR → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Confirmation de réservation",
      bodyText: `${CONFIRMATION_BODY_FR}\nTélécharger la facture`,
    })
    assert.equal(r.intent, "CONFIRMATION")
  })

  it("HTML normalisé accents / espaces multiples → CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Confirmation   de   réservation",
      bodyText: `
Confirmation&nbsp;&nbsp;de   réservation
Numéro de réservation : 9
Établissement : Appartement
Adresse : 5 avenue Victor
Arrivée : 10 janvier 2026
Départ : 12 janvier 2026
`,
    })
    assert.equal(r.intent, "CONFIRMATION")
  })
})

describe("classifyBookingEmailIntent — hors confirmation", () => {
  it("message établissement + ref footer → MESSAGE_ETABLISSEMENT", () => {
    const r = classifyBookingEmailIntent({
      subject: "Nouveau message",
      bodyText: `
Vous avez un nouveau message de l'établissement.
Voir les messages : https://booking.com/messages
Numéro de réservation : 1234.567.890
Adresse : 12 rue de la Paix
`,
    })
    assert.equal(r.intent, "MESSAGE_ETABLISSEMENT")
  })

  it("reçu avec ref + dates + adresse → RECU", () => {
    const r = classifyBookingEmailIntent({
      subject: "Voici votre reçu",
      bodyText: `
Voici votre reçu Booking
Numéro de réservation : 1234.567.890
Adresse : 12 rue de la Paix, Paris
Arrivée : 2026-01-01
Départ : 2026-01-02
Montant : 450 EUR
`,
    })
    assert.equal(r.intent, "RECU")
    assert.notEqual(r.intent, "CONFIRMATION")
  })

  it("vrai reçu sujet receipt + paiement malgré structure réservation → RECU", () => {
    const r = classifyBookingEmailIntent({
      subject: "Your Booking.com receipt",
      bodyText: `
Here's your receipt
Booking number: 11223344
Address: 10 Main Street
Check-in: 2026-01-01
Check-out: 2026-01-03
Payment receipt total: $320
Amount paid: $320
`,
    })
    assert.equal(r.intent, "RECU")
  })

  it("invoice / receipt EN → RECU", () => {
    const r = classifyBookingEmailIntent({
      subject: "Your Booking.com receipt",
      bodyText: `
Here's your receipt
Booking number: 11223344
Address: 10 Main Street
Payment receipt total: $320
`,
    })
    assert.equal(r.intent, "RECU")
  })

  it("CTA Payment invoice available seul sans confirmation → pas CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Booking.com",
      bodyText: "Payment invoice available for your stay.",
    })
    assert.notEqual(r.intent, "CONFIRMATION")
    assert.notEqual(r.intent, "RECU")
    assert.equal(r.intent, "AMBIGU")
  })

  it("annulation avec ref + dates + adresse → ANNULATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Réservation annulée",
      bodyText: `
Votre réservation a été annulée.
Numéro de réservation : 5555.666.777
Établissement : Hôtel Central
Adresse : 1 place de la Gare
Arrivée : 2026-11-01
Départ : 2026-11-03
`,
    })
    assert.equal(r.intent, "ANNULATION")
    assert.notEqual(r.intent, "CONFIRMATION")
  })

  it("sujet confirmation + corps message établissement → jamais CONFIRMATION", () => {
    const r = classifyBookingEmailIntent({
      subject: "Confirmation — nouveau message",
      bodyText:
        "Vous avez un nouveau message de l'établissement. Cliquez pour répondre.",
    })
    assert.notEqual(r.intent, "CONFIRMATION")
    assert.equal(r.intent, "MESSAGE_ETABLISSEMENT")
  })

  it("ref + nom sans dates → AMBIGU", () => {
    const r = classifyBookingEmailIntent({
      subject: "Booking.com",
      bodyText: `
Numéro de réservation : 7777.888.999
Établissement : Studio Centre
`,
    })
    assert.equal(r.intent, "AMBIGU")
  })

  it("dates + adresse sans preuve de confirmation → AMBIGU", () => {
    const r = classifyBookingEmailIntent({
      subject: "Booking.com",
      bodyText: `
Arrivée : 2026-08-01
Départ : 2026-08-03
Adresse : 12 rue de la Paix
`,
    })
    assert.equal(r.intent, "AMBIGU")
  })

  it("marketing Booking → AUTRE_PROUVE", () => {
    const r = classifyBookingEmailIntent({
      subject: "Offre spéciale Booking.com",
      bodyText: `
Promotion exclusive ! Offre spéciale ce week-end.
Newsletter Booking — découvrez nos destinations.
`,
    })
    assert.equal(r.intent, "AUTRE_PROUVE")
  })
})

describe("resolveBookingIntentScanDisposition", () => {
  it("CONFIRMATION proceed ; hors-confirmation permanent ; AMBIGU retryable", () => {
    assert.equal(
      resolveBookingIntentScanDisposition({
        intent: "CONFIRMATION",
        confidence: "high",
        evidence: [],
      }).action,
      "PROCEED_CONFIRMATION"
    )

    const host = resolveBookingIntentScanDisposition({
      intent: "MESSAGE_ETABLISSEMENT",
      confidence: "high",
      evidence: [],
    })
    assert.equal(host.action, "PERMANENT_IGNORE")

    const amb = resolveBookingIntentScanDisposition({
      intent: "AMBIGU",
      confidence: "low",
      evidence: [],
    })
    assert.equal(amb.action, "RETRYABLE_AMBIGUOUS")
    if (amb.action === "RETRYABLE_AMBIGUOUS") {
      assert.equal(amb.code, BOOKING_INTENT_IGNORE_CODES.AMBIGU)
    }
  })

  it("codes : hors-confirmation PERMANENT ; AMBIGU RETRYABLE", () => {
    for (const code of [
      BOOKING_INTENT_IGNORE_CODES.MESSAGE_ETABLISSEMENT,
      BOOKING_INTENT_IGNORE_CODES.RECU,
      BOOKING_INTENT_IGNORE_CODES.ANNULATION,
      BOOKING_INTENT_IGNORE_CODES.AUTRE_PROUVE,
    ]) {
      assert.equal(classifyBookingError(new Error(code)).kind, "PERMANENT")
    }
    const amb = classifyBookingError(
      new Error(BOOKING_INTENT_IGNORE_CODES.AMBIGU)
    )
    assert.equal(amb.kind, "RETRYABLE")
    assert.equal(amb.code, "BOOKING_EMAIL_INTENT_AMBIGUOUS")
  })
})

describe("applyBookingEmailIntentGate — chemin réel gmail-scan", () => {
  function emptyStats() {
    return {
      confirmationCount: 0,
      hostMessageIgnoredCount: 0,
      receiptIgnoredCount: 0,
      cancellationIgnoredCount: 0,
      otherIgnoredCount: 0,
      ambiguousCount: 0,
    }
  }

  it("CONFIRMATION → continue ; aucun lifecycle ignore/failure ; confirmationCount++", async () => {
    let extractPipelineCalls = 0
    let permanentCalls = 0
    let failureCalls = 0
    const stats = emptyStats()

    const result = await applyBookingEmailIntentGate({
      companyId: "co1",
      messageId: "m-conf",
      subject: "Confirmation de réservation",
      bodyText: CONFIRMATION_BODY_FR,
      stats,
      markPermanentIgnored: async () => {
        permanentCalls++
        return { status: "PERMANENTLY_IGNORED", errorCode: "x" }
      },
      markFailure: async () => {
        failureCalls++
        return { status: "RETRYABLE_FAILURE", errorCode: "x" }
      },
    })

    assert.equal(result.action, "CONTINUE_CONFIRMATION")
    if (result.action === "CONTINUE_CONFIRMATION") {
      extractPipelineCalls++
    }
    assert.equal(extractPipelineCalls, 1)
    assert.equal(permanentCalls, 0)
    assert.equal(failureCalls, 0)
    assert.equal(stats.confirmationCount, 1)
  })

  it("hors-confirmation prouvée → markPermanentIgnored + compteur ; pas d’extract", async () => {
    const fixtures: Array<{
      subject: string
      body: string
      intent: BookingEmailClassification["intent"]
      code: string
      statsKey:
        | "hostMessageIgnoredCount"
        | "receiptIgnoredCount"
        | "cancellationIgnoredCount"
        | "otherIgnoredCount"
    }> = [
      {
        subject: "Nouveau message",
        body: "Vous avez un nouveau message de l'établissement.",
        intent: "MESSAGE_ETABLISSEMENT",
        code: "IGNORED_BOOKING_HOST_MESSAGE",
        statsKey: "hostMessageIgnoredCount",
      },
      {
        subject: "Voici votre reçu",
        body: "Voici votre reçu Booking\nNuméro de réservation : 1",
        intent: "RECU",
        code: "IGNORED_BOOKING_RECEIPT",
        statsKey: "receiptIgnoredCount",
      },
      {
        subject: "Annulation",
        body: "Votre réservation a été annulée.\nNuméro de réservation : 2",
        intent: "ANNULATION",
        code: "IGNORED_BOOKING_CANCELLATION",
        statsKey: "cancellationIgnoredCount",
      },
      {
        subject: "Promo",
        body: "Promotion exclusive ! Offre spéciale newsletter.",
        intent: "AUTRE_PROUVE",
        code: "IGNORED_BOOKING_NON_CONFIRMATION",
        statsKey: "otherIgnoredCount",
      },
    ]

    for (const f of fixtures) {
      let permanentCode: string | null = null
      let failureCalls = 0
      const stats = emptyStats()
      const out = await applyBookingEmailIntentGate({
        companyId: "co1",
        messageId: `m-${f.statsKey}`,
        subject: f.subject,
        bodyText: f.body,
        stats,
        markPermanentIgnored: async (_c, _m, error) => {
          permanentCode = error.code
          return { status: "PERMANENTLY_IGNORED", errorCode: error.code }
        },
        markFailure: async () => {
          failureCalls++
          return { status: "RETRYABLE_FAILURE", errorCode: "x" }
        },
      })
      assert.equal(out.action, "STOP")
      assert.equal(out.classification.intent, f.intent)
      assert.equal(permanentCode, f.code)
      assert.equal(failureCalls, 0)
      assert.equal(stats[f.statsKey], 1)
      assert.equal(stats.confirmationCount, 0)
      if (out.action === "STOP") {
        assert.equal(out.reason, "PERMANENT_IGNORE")
        assert.equal(out.code, f.code)
      }
    }
  })

  it("AMBIGU avant plafond → markFailure retryable ; ambiguousCount++ ; pas d’extract", async () => {
    let failureCode: string | null = null
    let permanentCalls = 0
    const stats = emptyStats()
    const out = await applyBookingEmailIntentGate({
      companyId: "co1",
      messageId: "m-amb",
      subject: "Booking.com",
      bodyText: "Numéro de réservation : XYZ\nÉtablissement : Studio",
      stats,
      markPermanentIgnored: async () => {
        permanentCalls++
        return { status: "PERMANENTLY_IGNORED", errorCode: "x" }
      },
      markFailure: async ({ error }) => {
        failureCode = error.code
        assert.equal(error.kind, "RETRYABLE")
        return {
          status: "RETRYABLE_FAILURE",
          errorCode: error.code,
          nextRetryAt: new Date("2026-08-02T12:00:00Z"),
        }
      },
    })
    assert.equal(out.action, "STOP")
    if (out.action === "STOP") {
      assert.equal(out.reason, "RETRYABLE_AMBIGUOUS")
      assert.equal(out.code, "BOOKING_EMAIL_INTENT_AMBIGUOUS")
      assert.equal(out.telemetryKind, "retryable_failure")
      assert.equal(out.lifecycleStatus, "RETRYABLE_FAILURE")
      assert.equal(out.lifecycle.status, "RETRYABLE_FAILURE")
    }
    assert.equal(failureCode, "BOOKING_EMAIL_INTENT_AMBIGUOUS")
    assert.equal(permanentCalls, 0)
    assert.equal(stats.ambiguousCount, 1)
    assert.equal(stats.confirmationCount, 0)
  })

  it("course markFailure → SUCCEEDED : pas de permanent trompeur ni ambiguousCount", async () => {
    const stats = emptyStats()
    const out = await applyBookingEmailIntentGate({
      companyId: "co1",
      messageId: "m-race",
      subject: "Booking.com",
      bodyText: "Numéro de réservation : XYZ\nÉtablissement : Studio",
      stats,
      markPermanentIgnored: async () => {
        throw new Error("should not permanent")
      },
      markFailure: async () => ({
        status: "SUCCEEDED",
        errorCode: null,
      }),
    })
    assert.equal(out.action, "STOP")
    if (out.action !== "STOP") throw new Error("expected STOP")
    assert.equal(out.telemetryKind, "lifecycle_race_succeeded")
    assert.equal(out.lifecycleStatus, "SUCCEEDED")
    // Miroir route : permanent/retryable uniquement pour kinds exacts
    assert.notEqual(out.telemetryKind, "permanent_ignored")
    assert.notEqual(out.telemetryKind, "retryable_failure")
    assert.equal(stats.ambiguousCount, 0)
    assert.equal(stats.confirmationCount, 0)
  })

  it("statut lifecycle inattendu → lifecycle_unexpected, pas assimilé à permanent", async () => {
    const stats = emptyStats()
    const out = await applyBookingEmailIntentGate({
      companyId: "co1",
      messageId: "m-weird",
      subject: "Nouveau message",
      bodyText: "Vous avez un nouveau message de l'établissement.",
      stats,
      markPermanentIgnored: async () => ({
        status: "PROCESSING",
        errorCode: null,
      }),
      markFailure: async () => {
        throw new Error("should not fail")
      },
    })
    assert.equal(out.action, "STOP")
    if (out.action === "STOP") {
      assert.equal(out.telemetryKind, "lifecycle_unexpected")
      assert.equal(out.lifecycleStatus, "PROCESSING")
    }
    assert.equal(stats.hostMessageIgnoredCount, 0)
  })

  it("exception lifecycle → stats non incrémentées (pas de double comptage)", async () => {
    const stats = emptyStats()
    await assert.rejects(
      () =>
        applyBookingEmailIntentGate({
          companyId: "co1",
          messageId: "m-err",
          subject: "Nouveau message",
          bodyText: "Vous avez un nouveau message de l'établissement.",
          stats,
          markPermanentIgnored: async () => {
            throw new Error("lifecycle boom")
          },
          markFailure: async () => {
            throw new Error("should not be called")
          },
        }),
      /lifecycle boom/
    )
    assert.equal(stats.hostMessageIgnoredCount, 0)
    assert.equal(stats.confirmationCount, 0)
  })

  it("route.ts importe et appelle applyBookingEmailIntentGate avant extract", () => {
    const src = readFileSync(
      join(ROOT, "src/app/api/cron/gmail-scan/route.ts"),
      "utf8"
    )
    assert.ok(src.includes('from "@/lib/booking/booking-email-intent-gate"'))
    assert.ok(src.includes("applyBookingEmailIntentGate"))
    assert.equal(src.includes("classifyBookingEmailIntent("), false)
    const gateAt = src.indexOf("applyBookingEmailIntentGate")
    const extractAt = src.indexOf("extractBookingFields(")
    assert.ok(gateAt > 0 && extractAt > gateAt)
  })
})

describe("lifecycle AMBIGU retry borné + replay", () => {
  const prevMax = process.env.BOOKING_GMAIL_MAX_ATTEMPTS

  afterEach(() => {
    if (prevMax === undefined) delete process.env.BOOKING_GMAIL_MAX_ATTEMPTS
    else process.env.BOOKING_GMAIL_MAX_ATTEMPTS = prevMax
  })

  it("hors-confirmation permanent → claim suivant SKIP", async () => {
    const fake = createFakeLifecycleDb()
    const life = new BookingGmailMessageLifecycle(fake.api)
    await life.claimForProcessing("coA", "host1")
    await life.markPermanentIgnored(
      "coA",
      "host1",
      permanentBookingError("IGNORED_BOOKING_HOST_MESSAGE", "host")
    )
    const again = await life.claimForProcessing("coA", "host1")
    assert.deepEqual(again, { action: "SKIP", reason: "PERMANENTLY_IGNORED" })
  })

  it("AMBIGU : retry jusqu’au plafond puis permanent code conservé ; puis SKIP", async () => {
    process.env.BOOKING_GMAIL_MAX_ATTEMPTS = "3"
    assert.equal(getBookingGmailMaxAttempts(), 3)
    const fake = createFakeLifecycleDb()
    const life = new BookingGmailMessageLifecycle(fake.api)

    await life.claimForProcessing("coA", "amb1")
    const stats = {
      confirmationCount: 0,
      hostMessageIgnoredCount: 0,
      receiptIgnoredCount: 0,
      cancellationIgnoredCount: 0,
      otherIgnoredCount: 0,
      ambiguousCount: 0,
    }

    const first = await applyBookingEmailIntentGate({
      companyId: "coA",
      messageId: "amb1",
      subject: "Booking.com",
      bodyText: "Numéro de réservation : 1\nÉtablissement : X",
      stats,
      markPermanentIgnored: (c, m, e) => life.markPermanentIgnored(c, m, e),
      markFailure: (args) => life.markFailure(args),
    })
    assert.equal(first.action, "STOP")
    if (first.action === "STOP") {
      assert.equal(first.lifecycle.status, "RETRYABLE_FAILURE")
      assert.equal(first.lifecycle.errorCode, "BOOKING_EMAIL_INTENT_AMBIGUOUS")
    }
    assert.equal(stats.ambiguousCount, 1)

    const row1 = await fake.api.processedGmailMessage.findUnique({
      where: { companyId_messageId: { companyId: "coA", messageId: "amb1" } },
    })
    const claim2 = await life.claimForProcessing(
      "coA",
      "amb1",
      row1!.nextRetryAt ?? new Date()
    )
    assert.equal(claim2.action, "CLAIMED")

    const second = await applyBookingEmailIntentGate({
      companyId: "coA",
      messageId: "amb1",
      subject: "Booking.com",
      bodyText: "Numéro de réservation : 1\nÉtablissement : X",
      stats,
      markPermanentIgnored: (c, m, e) => life.markPermanentIgnored(c, m, e),
      markFailure: (args) => life.markFailure(args),
    })
    assert.equal(second.action, "STOP")
    if (second.action === "STOP") {
      assert.equal(second.lifecycle.status, "RETRYABLE_FAILURE")
    }
    assert.equal(stats.ambiguousCount, 2)

    const row2 = await fake.api.processedGmailMessage.findUnique({
      where: { companyId_messageId: { companyId: "coA", messageId: "amb1" } },
    })
    const claim3 = await life.claimForProcessing(
      "coA",
      "amb1",
      row2!.nextRetryAt ?? new Date()
    )
    assert.equal(claim3.action, "CLAIMED")
    if (claim3.action === "CLAIMED") {
      assert.equal(claim3.record.attemptCount, 3)
    }

    const third = await applyBookingEmailIntentGate({
      companyId: "coA",
      messageId: "amb1",
      subject: "Booking.com",
      bodyText: "Numéro de réservation : 1\nÉtablissement : X",
      stats,
      markPermanentIgnored: (c, m, e) => life.markPermanentIgnored(c, m, e),
      markFailure: (args) => life.markFailure(args),
    })
    assert.equal(third.action, "STOP")
    if (third.action === "STOP") {
      assert.equal(third.lifecycle.status, "PERMANENTLY_IGNORED")
      assert.equal(third.lifecycle.errorCode, "BOOKING_EMAIL_INTENT_AMBIGUOUS")
    }
    assert.equal(stats.ambiguousCount, 3)

    const after = await life.claimForProcessing("coA", "amb1")
    assert.deepEqual(after, { action: "SKIP", reason: "PERMANENTLY_IGNORED" })
  })

  it("markFailure AMBIGU au plafond conserve le code diagnostique", async () => {
    process.env.BOOKING_GMAIL_MAX_ATTEMPTS = "1"
    const fake = createFakeLifecycleDb()
    const life = new BookingGmailMessageLifecycle(fake.api)
    await life.claimForProcessing("coA", "amb-max")
    const failed = await life.markFailure({
      companyId: "coA",
      messageId: "amb-max",
      error: retryableBookingError(
        "BOOKING_EMAIL_INTENT_AMBIGUOUS",
        "intent ambigu"
      ),
    })
    assert.equal(failed.status, "PERMANENTLY_IGNORED")
    assert.equal(failed.errorCode, "BOOKING_EMAIL_INTENT_AMBIGUOUS")
  })
})
