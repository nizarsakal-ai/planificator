/**
 * Tests unitaires — extraction Booking IA + fallback (C-BOOK-001-R2 / M1).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  classifyBookingError,
  isClassifiedBookingError,
} from "@/lib/booking/booking-gmail-errors"
import {
  BOOKING_AI_REJECTION_REASONS,
  extractBookingFields,
  hasUsefulBookingData,
  normalizeAiBookingJson,
  regexFallbackParser,
  tryParseAiBookingContent,
  type BookingAiClient,
  type BookingExtractDiagnosticContext,
} from "@/lib/booking/extract-booking-fields"
import {
  extractNormalizedGmailBody,
  extractNormalizedGmailBodyWithMetadata,
} from "@/lib/booking/booking-gmail-body.service"
import {
  BOOKING_EMAIL_EXTRACT_MAX_CEILING,
  getBookingEmailExtractMax,
  truncateBookingEmailForExtract,
} from "@/lib/booking/booking-pending-merge"

function aiClientReturning(
  content: Array<{ type: string; text?: string }>
): BookingAiClient {
  return {
    messages: {
      create: async () => ({ content }),
    },
  }
}

const EMPTY_EMAIL = "Bonjour, ceci est un email sans adresse ni dates Booking."
const USEFUL_EMAIL =
  "Confirmation : Appartement Duplex Centre\nAdresse : 12 rue de la Paix\nArrivée 20 juillet 2026\nDépart 25 juillet 2026"

function markerOffsets(text: string) {
  const offset = (pattern: RegExp) => pattern.exec(text)?.index ?? -1
  return {
    Arrivee: offset(/\bArriv[ée]e\b/i),
    Depart: offset(/\bD[ée]part\b/i),
    "Check-in": offset(/\bCheck[\s-]?in\b/i),
    "Check-out": offset(/\bCheck[\s-]?out\b/i),
  }
}

function assertNoPiiInDiagnostic(payload: unknown) {
  const serialized = JSON.stringify(payload)
  for (const fragment of [
    "12 rue de la Paix",
    "Appartement Duplex Centre",
    "20 juillet 2026",
    "987654321",
    "Makram",
  ]) {
    assert.equal(
      serialized.includes(fragment),
      false,
      `PII leak candidate: ${fragment}`
    )
  }
}

describe("extract-booking-fields — M1 IA inexploitable", () => {
  it("1. JSON IA invalide + regex vide → RETRYABLE (PROVIDER_INVALID_RESPONSE)", async () => {
    await assert.rejects(
      () =>
        extractBookingFields(
          EMPTY_EMAIL,
          "msg_bad_json",
          aiClientReturning([{ type: "text", text: "{not-json" }])
        ),
      (err: unknown) => {
        assert.ok(isClassifiedBookingError(err))
        assert.equal(err.kind, "RETRYABLE")
        assert.equal(err.code, "PROVIDER_INVALID_RESPONSE")
        const classified = classifyBookingError(err)
        assert.equal(classified.kind, "RETRYABLE")
        assert.notEqual(classified.code, "NO_USEFUL_BOOKING_DATA")
        return true
      }
    )
  })

  it("2. contenu IA non textuel + regex vide → RETRYABLE", async () => {
    await assert.rejects(
      () =>
        extractBookingFields(
          EMPTY_EMAIL,
          "msg_tool",
          aiClientReturning([{ type: "tool_use" }])
        ),
      (err: unknown) => {
        assert.ok(isClassifiedBookingError(err))
        assert.equal(err.kind, "RETRYABLE")
        assert.equal(err.code, "PROVIDER_INVALID_RESPONSE")
        return true
      }
    )
  })

  it("3. JSON IA invalide + regex exploitable → fallback (pas d'erreur)", async () => {
    const parsed = await extractBookingFields(
      USEFUL_EMAIL,
      "msg_fallback",
      aiClientReturning([{ type: "text", text: "```json\nbroken" }])
    )
    assert.equal(hasUsefulBookingData(parsed), true)
    assert.ok(parsed.address || parsed.propertyName)
  })

  it("4. JSON IA valide sans donnée + regex vide → parse vide (permanent en aval, pas throw)", async () => {
    const emptyJson = JSON.stringify({
      propertyName: null,
      address: null,
      city: null,
      zipCode: null,
      startDate: null,
      endDate: null,
      doorCode: null,
      contactName: null,
      contactPhone: null,
      notes: null,
      teamName: null,
    })
    const parsed = await extractBookingFields(
      EMPTY_EMAIL,
      "msg_empty_ai",
      aiClientReturning([{ type: "text", text: emptyJson }])
    )
    assert.equal(hasUsefulBookingData(parsed), false)
    // Contrat route : NO_USEFUL seulement après analyse réussie sans donnée
    assert.equal(hasUsefulBookingData(regexFallbackParser(EMPTY_EMAIL)), false)
  })

  it("structure JSON invalide (tableau) + regex vide → RETRYABLE", async () => {
    await assert.rejects(
      () =>
        extractBookingFields(
          EMPTY_EMAIL,
          "msg_array",
          aiClientReturning([{ type: "text", text: "[]" }])
        ),
      (err: unknown) => {
        assert.ok(isClassifiedBookingError(err))
        assert.equal(err.code, "PROVIDER_INVALID_RESPONSE")
        return true
      }
    )
  })

  it("réponse IA vide + regex vide → RETRYABLE", async () => {
    await assert.rejects(
      () =>
        extractBookingFields(
          EMPTY_EMAIL,
          "msg_blank",
          aiClientReturning([{ type: "text", text: "   " }])
        ),
      (err: unknown) => {
        assert.ok(isClassifiedBookingError(err))
        assert.equal(err.code, "PROVIDER_INVALID_RESPONSE")
        return true
      }
    )
  })

  it("tryParse / normalize helpers", () => {
    assert.equal(tryParseAiBookingContent({ type: "tool_use" }), null)
    assert.equal(tryParseAiBookingContent({ type: "text", text: "" }), null)
    assert.equal(normalizeAiBookingJson([1, 2]), null)
    assert.equal(normalizeAiBookingJson({ address: 12 }), null)
    assert.deepEqual(normalizeAiBookingJson({ address: "1 rue X" })?.address, "1 rue X")
  })
})

describe("PLAN-BOOKING-EXTRACT-005 — diagnostic sans PII", () => {
  const context: BookingExtractDiagnosticContext = {
    companyId: "company-id-only",
    normalizedTextLength: 17123,
    sourceMime: "text/html",
    normalizedMarkerOffsets: {
      Arrivee: 8120,
      Depart: 8190,
      "Check-in": -1,
      "Check-out": -1,
    },
    analyzedMarkerOffsets: {
      Arrivee: 8120,
      Depart: 8190,
      "Check-in": -1,
      "Check-out": -1,
    },
    truncatedTextLength: 16000,
    wasTruncated: true,
  }

  it("journalise la cause JSON et l'état du fallback, jamais le contenu", async () => {
    const calls: unknown[][] = []
    const previous = console.warn
    console.warn = (...args: unknown[]) => calls.push(args)
    try {
      const parsed = await extractBookingFields(
        USEFUL_EMAIL,
        "message-id-only",
        aiClientReturning([{ type: "text", text: "{not-json" }]),
        context
      )
      assert.equal(parsed.startDate, "2026-07-20")
    } finally {
      console.warn = previous
    }

    const diagnostic = calls.find(
      (args) => args[0] === "[booking-extract-diagnostic]"
    )?.[1] as Record<string, unknown>
    assert.ok(diagnostic)
    assert.equal(diagnostic.aiRejectionReason, "json_invalid")
    assert.equal(diagnostic.validationField, null)
    assert.equal(diagnostic.fallbackStartDatePresent, true)
    assert.equal(diagnostic.sourceMime, "text/html")
    assert.deepEqual(
      diagnostic.normalizedMarkerOffsets,
      context.normalizedMarkerOffsets
    )
    assert.deepEqual(
      diagnostic.analyzedMarkerOffsets,
      context.analyzedMarkerOffsets
    )
    assert.deepEqual(diagnostic.normalizedMarkerPresent, {
      Arrivee: true,
      Depart: true,
      "Check-in": false,
      "Check-out": false,
    })
    assert.equal(context.lastAiRejectionReason, "json_invalid")
    assert.equal(context.lastFallbackStartDatePresent, true)
    assertNoPiiInDiagnostic(diagnostic)
  })

  it("identifie précisément le champ au type invalide sans logger sa valeur", async () => {
    const calls: unknown[][] = []
    const previous = console.warn
    console.warn = (...args: unknown[]) => calls.push(args)
    try {
      await extractBookingFields(
        USEFUL_EMAIL,
        "message-type-mismatch",
        aiClientReturning([
          {
            type: "text",
            text: JSON.stringify({
              startDate: "2026-07-20",
              doorCode: 987654321,
            }),
          },
        ]),
        context
      )
    } finally {
      console.warn = previous
    }

    const diagnostic = calls.find(
      (args) => args[0] === "[booking-extract-diagnostic]"
    )?.[1] as Record<string, unknown>
    assert.equal(diagnostic.aiRejectionReason, "type_mismatch")
    assert.equal(diagnostic.validationField, "doorCode")
    assert.equal(diagnostic.aiStartDatePresent, true)
    assertNoPiiInDiagnostic(diagnostic)
  })

  it("parse_error pour texte non-JSON (markdown) sans PII", async () => {
    const calls: unknown[][] = []
    const previous = console.warn
    console.warn = (...args: unknown[]) => calls.push(args)
    try {
      await extractBookingFields(
        USEFUL_EMAIL,
        "message-parse-error",
        aiClientReturning([{ type: "text", text: "```json\nbroken" }]),
        context
      )
    } finally {
      console.warn = previous
    }
    const diagnostic = calls.find(
      (args) => args[0] === "[booking-extract-diagnostic]"
    )?.[1] as Record<string, unknown>
    assert.equal(diagnostic.aiRejectionReason, "parse_error")
    assertNoPiiInDiagnostic(diagnostic)
  })

  it("multipart plain non vide + html → plain conservé", () => {
    const plain = Buffer.from("Arrivée 20 juillet 2026", "utf8").toString(
      "base64url"
    )
    const html = Buffer.from(
      "<p>Arrivée 21 juillet 2026</p>",
      "utf8"
    ).toString("base64url")
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: plain } },
        { mimeType: "text/html", body: { data: html } },
      ],
    }
    const normalized = extractNormalizedGmailBodyWithMetadata(payload)
    assert.equal(normalized.sourceMime, "text/plain")
    assert.equal(normalized.text, "Arrivée 20 juillet 2026")
    assert.equal(normalized.text, extractNormalizedGmailBody(payload))
  })

  it("multipart plain vide + html non vide → sourceMime text/html", () => {
    const plainEmpty = Buffer.from("", "utf8").toString("base64url")
    const html = Buffer.from(
      "<p>Arrivée 21 juillet 2026 — 12 rue de la Paix</p>",
      "utf8"
    ).toString("base64url")
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: plainEmpty } },
        { mimeType: "text/html", body: { data: html } },
      ],
    }
    const withMeta = extractNormalizedGmailBodyWithMetadata(payload)
    const legacy = extractNormalizedGmailBody(payload)
    assert.equal(withMeta.sourceMime, "text/html")
    assert.equal(withMeta.text, legacy)
    assert.match(withMeta.text, /Arrivée 21 juillet 2026/)
  })

  it("schema_validation pour tableau JSON", async () => {
    const calls: unknown[][] = []
    const previous = console.warn
    console.warn = (...args: unknown[]) => calls.push(args)
    try {
      await assert.rejects(() =>
        extractBookingFields(
          EMPTY_EMAIL,
          "message-schema",
          aiClientReturning([{ type: "text", text: "[]" }]),
          context
        )
      )
    } finally {
      console.warn = previous
    }
    const diagnostic = calls.find(
      (args) => args[0] === "[booking-extract-diagnostic]"
    )?.[1] as Record<string, unknown>
    assert.equal(diagnostic.aiRejectionReason, "schema_validation")
    assertNoPiiInDiagnostic(diagnostic)
  })

  it("succès IA : pas de regex diag (fallback non peuplé)", async () => {
    const validWithoutStart = JSON.stringify({
      propertyName: "Logement test",
      address: null,
      city: null,
      zipCode: null,
      startDate: null,
      endDate: "2026-08-07",
      doorCode: null,
      contactName: null,
      contactPhone: null,
      notes: null,
      teamName: null,
    })
    const fresh: BookingExtractDiagnosticContext = {
      ...context,
      lastFallbackStartDatePresent: undefined,
      lastFallbackEndDatePresent: undefined,
    }
    await extractBookingFields(
      EMPTY_EMAIL,
      "message-valid-no-start",
      aiClientReturning([{ type: "text", text: validWithoutStart }]),
      fresh
    )
    assert.equal(fresh.lastAiRejectionReason, null)
    assert.equal(fresh.lastAiStartDatePresent, false)
    assert.equal(fresh.lastFallbackStartDatePresent, undefined)
    assert.equal(fresh.lastFallbackEndDatePresent, undefined)
  })

  it("contexte diagnostic absent → résultat strictement identique", async () => {
    const broken = aiClientReturning([{ type: "text", text: "{not-json" }])
    const withCtx = await extractBookingFields(
      USEFUL_EMAIL,
      "msg-ctx",
      broken,
      { ...context }
    )
    const withoutCtx = await extractBookingFields(
      USEFUL_EMAIL,
      "msg-no-ctx",
      broken
    )
    assert.deepEqual(withCtx, withoutCtx)

    const validAi = aiClientReturning([
      {
        type: "text",
        text: JSON.stringify({
          propertyName: "X",
          address: "1 rue Y",
          city: null,
          zipCode: null,
          startDate: "2026-07-20",
          endDate: "2026-07-25",
          doorCode: null,
          contactName: null,
          contactPhone: null,
          notes: null,
          teamName: null,
        }),
      },
    ])
    const a = await extractBookingFields(USEFUL_EMAIL, "a", validAi, {
      ...context,
    })
    const b = await extractBookingFields(USEFUL_EMAIL, "b", validAi)
    assert.deepEqual(a, b)
  })

  it("offsets Arrivée / Départ calculés sur le texte analysé", () => {
    const text =
      "Intro\nArrivée 20 juillet 2026\nMilieu\nDépart 25 juillet 2026\nFin"
    const offsets = markerOffsets(text)
    assert.equal(offsets.Arrivee, text.indexOf("Arrivée"))
    assert.equal(offsets.Depart, text.indexOf("Départ"))
    assert.equal(offsets["Check-in"], -1)
    assert.equal(offsets["Check-out"], -1)
  })

  it("troncature true et false reflétées dans le contexte", () => {
    const extractMax = getBookingEmailExtractMax()
    const short = "Arrivée 20 juillet 2026 — Départ 25 juillet 2026"
    const truncatedShort = truncateBookingEmailForExtract(short)
    assert.equal(truncatedShort.length < short.length, false)
    assert.equal(truncatedShort.length, short.length)

    const markerBlock = "\nArrivée 20 juillet 2026\nDépart 25 juillet 2026\n"
    const long =
      "x".repeat(extractMax + 100) +
      markerBlock +
      "y".repeat(Math.max(1000, BOOKING_EMAIL_EXTRACT_MAX_CEILING - extractMax))
    const truncatedLong = truncateBookingEmailForExtract(long)
    assert.equal(truncatedLong.length < long.length, true)
    assert.equal(truncatedLong.length, extractMax)

    const analyzed = markerOffsets(truncatedLong)
    const normalized = markerOffsets(long)
    assert.equal(analyzed.Arrivee, -1)
    assert.equal(analyzed.Depart, -1)
    assert.ok(normalized.Arrivee >= extractMax)
    assert.ok(normalized.Depart > normalized.Arrivee)

    const wasTruncated = truncatedLong.length < long.length
    assert.equal(wasTruncated, true)
    assert.equal(truncatedShort.length < short.length, false)
  })

  it("taxonomie publique sans raison morte required_field_absent", () => {
    assert.deepEqual([...BOOKING_AI_REJECTION_REASONS], [
      "json_invalid",
      "parse_error",
      "schema_validation",
      "type_mismatch",
      "other",
    ])
    assert.equal(
      (BOOKING_AI_REJECTION_REASONS as readonly string[]).includes(
        "required_field_absent"
      ),
      false
    )
  })
})
