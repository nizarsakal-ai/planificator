/**
 * PLAN-BOOKING-FINAL LOT 2A — extract max ≠ persist max.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BOOKING_EMAIL_BODY_PERSIST_MAX,
  BOOKING_EMAIL_EXTRACT_MAX_CEILING,
  BOOKING_EMAIL_EXTRACT_MAX_DEFAULT,
  BOOKING_EMAIL_EXTRACT_MAX_MIN,
  getBookingEmailExtractMax,
  truncateBookingEmailForExtract,
  truncateBookingEmailForPersist,
} from "@/lib/booking/booking-pending-merge"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

function makeBodyWithMarker(beforeLen: number, marker: string, afterPad = 100): string {
  return "A".repeat(beforeLen) + marker + "B".repeat(afterPad)
}

describe("getBookingEmailExtractMax", () => {
  const prev = process.env.BOOKING_EMAIL_EXTRACT_MAX

  afterEach(() => {
    if (prev === undefined) delete process.env.BOOKING_EMAIL_EXTRACT_MAX
    else process.env.BOOKING_EMAIL_EXTRACT_MAX = prev
  })

  it("absent → défaut 16000", () => {
    delete process.env.BOOKING_EMAIL_EXTRACT_MAX
    assert.equal(getBookingEmailExtractMax(), BOOKING_EMAIL_EXTRACT_MAX_DEFAULT)
  })

  it("vide / espaces → défaut", () => {
    process.env.BOOKING_EMAIL_EXTRACT_MAX = "   "
    assert.equal(getBookingEmailExtractMax(), BOOKING_EMAIL_EXTRACT_MAX_DEFAULT)
  })

  it("non entier / négatif / hors bornes → défaut", () => {
    for (const v of ["12.5", "abc", "0", "-1", "3999", String(BOOKING_EMAIL_EXTRACT_MAX_CEILING + 1)]) {
      process.env.BOOKING_EMAIL_EXTRACT_MAX = v
      assert.equal(
        getBookingEmailExtractMax(),
        BOOKING_EMAIL_EXTRACT_MAX_DEFAULT,
        `attendu défaut pour ${v}`
      )
    }
  })

  it("entier valide dans les bornes → valeur", () => {
    process.env.BOOKING_EMAIL_EXTRACT_MAX = "8000"
    assert.equal(getBookingEmailExtractMax(), 8000)
    process.env.BOOKING_EMAIL_EXTRACT_MAX = String(BOOKING_EMAIL_EXTRACT_MAX_MIN)
    assert.equal(getBookingEmailExtractMax(), BOOKING_EMAIL_EXTRACT_MAX_MIN)
    process.env.BOOKING_EMAIL_EXTRACT_MAX = String(BOOKING_EMAIL_EXTRACT_MAX_CEILING)
    assert.equal(getBookingEmailExtractMax(), BOOKING_EMAIL_EXTRACT_MAX_CEILING)
  })
})

describe("truncateBookingEmailForExtract / Persist", () => {
  const prev = process.env.BOOKING_EMAIL_EXTRACT_MAX

  afterEach(() => {
    if (prev === undefined) delete process.env.BOOKING_EMAIL_EXTRACT_MAX
    else process.env.BOOKING_EMAIL_EXTRACT_MAX = prev
  })

  it("marqueur après 4000 reste visible pour l’extraction, pas pour la persist", () => {
    delete process.env.BOOKING_EMAIL_EXTRACT_MAX
    const marker = "<<ADDR_AFTER_4K>>"
    const body = makeBodyWithMarker(BOOKING_EMAIL_BODY_PERSIST_MAX, marker)
    const forExtract = truncateBookingEmailForExtract(body)
    const forPersist = truncateBookingEmailForPersist(body)

    assert.ok(forExtract.includes(marker), "extract doit conserver le marqueur >4000")
    assert.equal(forPersist.includes(marker), false, "persist ne doit pas contenir le marqueur")
    assert.ok(forPersist.length <= BOOKING_EMAIL_BODY_PERSIST_MAX)
    assert.equal(forPersist.length, BOOKING_EMAIL_BODY_PERSIST_MAX)
    assert.ok(forExtract.length > BOOKING_EMAIL_BODY_PERSIST_MAX)
    assert.ok(forExtract.length <= BOOKING_EMAIL_EXTRACT_MAX_DEFAULT)
  })

  it("corps > extract max → tronqué à la limite d’extraction", () => {
    delete process.env.BOOKING_EMAIL_EXTRACT_MAX
    const body = "X".repeat(BOOKING_EMAIL_EXTRACT_MAX_DEFAULT + 5000)
    const forExtract = truncateBookingEmailForExtract(body)
    assert.equal(forExtract.length, BOOKING_EMAIL_EXTRACT_MAX_DEFAULT)
  })

  it("persist max reste 4000 indépendamment de extract max", () => {
    process.env.BOOKING_EMAIL_EXTRACT_MAX = "8000"
    const body = "Y".repeat(12000)
    assert.equal(truncateBookingEmailForPersist(body).length, BOOKING_EMAIL_BODY_PERSIST_MAX)
    assert.equal(truncateBookingEmailForExtract(body).length, 8000)
  })
})

describe("gmail-scan LOT2A wiring", () => {
  it("sépare extract et persist ; n’utilise plus PERSIST_MAX pour extractBookingFields", () => {
    const src = readFileSync(join(ROOT, "src/app/api/cron/gmail-scan/route.ts"), "utf8")
    assert.match(src, /truncateBookingEmailForExtract/)
    assert.match(src, /truncateBookingEmailForPersist/)
    assert.match(src, /emailTextForExtract/)
    assert.match(src, /emailTextForPersist/)
    assert.equal(
      /extractBookingFields\(\s*\n?\s*emailText\b/.test(src) ||
        /extractBookingFields\(\s*emailText\b/.test(src),
      false
    )
    assert.match(src, /extractBookingFields\(\s*\n?\s*emailTextForExtract/)
    assert.match(src, /emailBody:\s*emailTextForPersist/)
  })
})
