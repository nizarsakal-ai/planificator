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
  extractBookingFields,
  hasUsefulBookingData,
  normalizeAiBookingJson,
  regexFallbackParser,
  tryParseAiBookingContent,
  type BookingAiClient,
} from "@/lib/booking/extract-booking-fields"

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
