/**
 * PLAN-BOOKING-UX-001 LOT 1 — flag pending-only, scan-result, UI/actions garde-fous.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, it } from "node:test"
import { isBookingScanPendingOnly } from "@/lib/booking/booking-scan-pending-only-flag"
import { createOrGetBookingScanResult } from "@/lib/booking/booking-scan-result"
import { isPendingReady } from "@/lib/booking/booking-pending-ready"
import type { PendingAccommodation, Prisma } from "@prisma/client"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

describe("isBookingScanPendingOnly", () => {
  const prev = process.env.BOOKING_SCAN_PENDING_ONLY

  afterEach(() => {
    if (prev === undefined) delete process.env.BOOKING_SCAN_PENDING_ONLY
    else process.env.BOOKING_SCAN_PENDING_ONLY = prev
  })

  it("absent → false", () => {
    delete process.env.BOOKING_SCAN_PENDING_ONLY
    assert.equal(isBookingScanPendingOnly(), false)
  })

  it('"false" / "TRUE" / "1" → false', () => {
    process.env.BOOKING_SCAN_PENDING_ONLY = "false"
    assert.equal(isBookingScanPendingOnly(), false)
    process.env.BOOKING_SCAN_PENDING_ONLY = "TRUE"
    assert.equal(isBookingScanPendingOnly(), false)
    process.env.BOOKING_SCAN_PENDING_ONLY = "1"
    assert.equal(isBookingScanPendingOnly(), false)
  })

  it('exactement "true" → true', () => {
    process.env.BOOKING_SCAN_PENDING_ONLY = "true"
    assert.equal(isBookingScanPendingOnly(), true)
  })
})

describe("isPendingReady (UI dérivé)", () => {
  it("Prêt uniquement avec adresse + dates", () => {
    assert.equal(
      isPendingReady({
        address: "12 rue X",
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-08-05"),
      }),
      true
    )
    assert.equal(
      isPendingReady({
        address: null,
        startDate: new Date("2026-08-01"),
        endDate: new Date("2026-08-05"),
      }),
      false
    )
    assert.equal(
      isPendingReady({
        address: "12 rue X",
        startDate: null,
        endDate: new Date("2026-08-05"),
      }),
      false
    )
  })
})

type AccRow = {
  id: string
  companyId: string
  gmailSourceMessageId: string | null
}

function makeFakeScanTx() {
  const pendings: PendingAccommodation[] = []
  const accommodations: AccRow[] = []
  let pendingSeq = 0
  let accSeq = 0
  let notificationCount = 0

  const tx = {
    pendingAccommodation: {
      async findFirst({
        where,
      }: {
        where: { companyId: string; gmailMessageId: string }
      }) {
        return (
          pendings.find(
            (p) =>
              p.companyId === where.companyId && p.gmailMessageId === where.gmailMessageId
          ) ?? null
        )
      },
      async create({ data }: { data: Partial<PendingAccommodation> & { companyId: string; gmailMessageId: string } }) {
        if (
          pendings.some(
            (p) => p.companyId === data.companyId && p.gmailMessageId === data.gmailMessageId
          )
        ) {
          throw Object.assign(new Error("Unique"), { code: "P2002" })
        }
        const row = {
          id: `pend_${++pendingSeq}`,
          companyId: data.companyId,
          gmailMessageId: data.gmailMessageId,
          propertyName: data.propertyName ?? null,
          address: data.address ?? null,
          city: data.city ?? null,
          zipCode: data.zipCode ?? null,
          startDate: data.startDate ?? null,
          endDate: data.endDate ?? null,
          doorCode: data.doorCode ?? null,
          contactName: data.contactName ?? null,
          contactPhone: data.contactPhone ?? null,
          notes: data.notes ?? null,
          rawEmailSnippet: data.rawEmailSnippet ?? null,
          status: "PENDING" as const,
          accommodationId: null,
          confirmedById: null,
          confirmedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies PendingAccommodation
        pendings.push(row)
        return row
      },
      async update({ where, data }: { where: { id: string }; data: Partial<PendingAccommodation> }) {
        const row = pendings.find((p) => p.id === where.id)
        if (!row) throw new Error("missing")
        Object.assign(row, data, { updatedAt: new Date() })
        return row
      },
    },
    accommodation: {
      async findFirst({
        where,
      }: {
        where: { companyId: string; gmailSourceMessageId: string }
      }) {
        return (
          accommodations.find(
            (a) =>
              a.companyId === where.companyId &&
              a.gmailSourceMessageId === where.gmailSourceMessageId
          ) ?? null
        )
      },
      async create({
        data,
      }: {
        data: { companyId: string; gmailSourceMessageId: string; teamId: string }
      }) {
        if (
          accommodations.some(
            (a) =>
              a.companyId === data.companyId &&
              a.gmailSourceMessageId === data.gmailSourceMessageId
          )
        ) {
          throw Object.assign(new Error("Unique"), { code: "P2002" })
        }
        const row = {
          id: `acc_${++accSeq}`,
          companyId: data.companyId,
          gmailSourceMessageId: data.gmailSourceMessageId,
        }
        accommodations.push(row)
        return row
      },
    },
    user: {
      async findMany() {
        return [{ id: "admin1" }]
      },
    },
    notification: {
      async createMany() {
        notificationCount++
        return { count: 1 }
      },
    },
  }

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    pendings,
    accommodations,
    get notificationCount() {
      return notificationCount
    },
  }
}

const fullParsed = {
  propertyName: "Appart Test",
  address: "10 rue de Paris",
  city: "Lyon",
  zipCode: "69001",
  startDate: "2026-09-01",
  endDate: "2026-09-05",
  doorCode: null,
  contactName: null,
  contactPhone: null,
  notes: null,
  teamName: "Alpha",
  bookingReference: null,
  status: null,
}

describe("createOrGetBookingScanResult — BOOKING_SCAN_PENDING_ONLY", () => {
  const prev = process.env.BOOKING_SCAN_PENDING_ONLY

  afterEach(() => {
    if (prev === undefined) delete process.env.BOOKING_SCAN_PENDING_ONLY
    else process.env.BOOKING_SCAN_PENDING_ONLY = prev
  })

  it("flag OFF + données complètes → Accommodation (historique)", async () => {
    delete process.env.BOOKING_SCAN_PENDING_ONLY
    const fake = makeFakeScanTx()
    const r = await createOrGetBookingScanResult(fake.tx, {
      companyId: "co1",
      messageId: "msg-hist",
      snippet: "snippet",
      parsed: fullParsed,
      matchedTeamId: "team1",
      adminId: "admin1",
      emailBody: "body long enough",
    })
    assert.equal(r.resultType, "ACCOMMODATION")
    assert.equal(r.createdNew, true)
    assert.equal(fake.accommodations.length, 1)
    assert.equal(fake.pendings.length, 0)
  })

  it("flag ON + données complètes + équipe → Pending uniquement", async () => {
    process.env.BOOKING_SCAN_PENDING_ONLY = "true"
    const fake = makeFakeScanTx()
    const r = await createOrGetBookingScanResult(fake.tx, {
      companyId: "co1",
      messageId: "msg-po",
      snippet: "snippet",
      parsed: fullParsed,
      matchedTeamId: "team1",
      adminId: "admin1",
      emailBody: "body long enough",
    })
    assert.equal(r.resultType, "PENDING_ACCOMMODATION")
    assert.equal(r.createdNew, true)
    assert.equal(fake.accommodations.length, 0)
    assert.equal(fake.pendings.length, 1)
    assert.equal(fake.pendings[0].address, "10 rue de Paris")
  })

  it("flag ON — rejeu même message : pas de doublon, merge", async () => {
    process.env.BOOKING_SCAN_PENDING_ONLY = "true"
    const fake = makeFakeScanTx()
    const input = {
      companyId: "co1",
      messageId: "msg-replay",
      snippet: "snippet",
      parsed: { ...fullParsed, doorCode: null as string | null },
      matchedTeamId: "team1",
      adminId: "admin1",
      emailBody: "body-1",
    }
    const r1 = await createOrGetBookingScanResult(fake.tx, input)
    assert.equal(r1.createdNew, true)

    const r2 = await createOrGetBookingScanResult(fake.tx, {
      ...input,
      parsed: { ...fullParsed, doorCode: "1234", address: "10 rue de Paris" },
      emailBody: "body-2-longer-content",
    })
    assert.equal(r2.resultType, "PENDING_ACCOMMODATION")
    assert.equal(r2.createdNew, false)
    assert.equal(fake.pendings.length, 1)
    assert.equal(fake.pendings[0].doorCode, "1234")
    assert.equal(fake.accommodations.length, 0)
  })
})

describe("LOT 1 — garde-fous source", () => {
  it("actions : requireBookingValidationAdmin sur update/confirm/dismiss/get", () => {
    const src = readFileSync(join(ROOT, "src/lib/actions/gmail.actions.ts"), "utf8")
    const core = readFileSync(join(ROOT, "src/lib/actions/gmail-pending-update.core.ts"), "utf8")
    assert.ok(src.includes("requireBookingValidationAdmin"))
    assert.ok(src.includes("export async function updatePendingAccommodation"))
    assert.ok(src.includes("updatePendingAccommodationImpl"))
    assert.match(
      src,
      /export async function confirmPendingAccommodation[\s\S]*?requireBookingValidationAdmin/
    )
    assert.match(
      src,
      /export async function dismissPendingAccommodation[\s\S]*?requireBookingValidationAdmin/
    )
    assert.match(
      src,
      /export async function getPendingAccommodations[\s\S]*?requireBookingValidationAdmin/
    )
    assert.ok(src.includes('["ADMIN", "SUPER_ADMIN"]'))
    assert.ok(src.includes("active: true"))
    assert.ok(core.includes(".strict()"))
    assert.ok(core.includes("export async function updatePendingAccommodationImpl"))
  })

  it("UI : pas de Traiter avec l'IA ; router.refresh présent", () => {
    const banner = readFileSync(
      join(ROOT, "src/components/logements/PendingBookingsBanner.tsx"),
      "utf8"
    )
    const dialog = readFileSync(
      join(ROOT, "src/components/logements/PendingBookingsDialog.tsx"),
      "utf8"
    )
    assert.equal(banner.includes("Traiter avec l'IA"), false)
    assert.equal(banner.includes("autoProcessPendingAccommodations"), false)
    assert.ok(banner.includes("Logements Booking à valider"))
    assert.ok(banner.includes("Prêts"))
    assert.ok(banner.includes("Incomplets"))
    assert.ok(dialog.includes("router.refresh()"))
    assert.ok(dialog.includes("updatePendingAccommodation"))
    assert.ok(dialog.includes("Valider et créer"))
    assert.ok(dialog.includes("Rejeter"))
  })

  it("scan-result lit le flag pending-only", () => {
    const src = readFileSync(join(ROOT, "src/lib/booking/booking-scan-result.ts"), "utf8")
    assert.ok(src.includes("isBookingScanPendingOnly"))
    assert.ok(src.includes("!isBookingScanPendingOnly()"))
  })
})
