/**
 * PLAN-BOOKING-ADDRESS-RELIABILITY-001-R1 — tests M1–M4 + mineurs.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { decodeHtmlEntities, htmlToPlainText } from "@/lib/text/html-to-plain-text"
import {
  BOOKING_UI_EMAIL_PREVIEW_MAX,
  buildPendingEnrichmentUpdate,
  hasBookingAddress,
  pickEmailTextForReprocess,
  resolveConfirmAddress,
  toBookingUiEmailPreview,
} from "@/lib/booking/booking-pending-merge"
import {
  extractBookingFields,
  mergeAiWithRegexFallback,
  regexFallbackParser,
  type BookingAiClient,
} from "@/lib/booking/extract-booking-fields"
import {
  classifyBookingError,
  retryableBookingError,
} from "@/lib/booking/booking-gmail-errors"
import {
  extractNormalizedGmailBody,
  fetchBookingGmailMessageBody,
} from "@/lib/booking/booking-gmail-body.service"
import {
  ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS,
  isAnyPrismaUniqueViolation,
  isPrismaUniqueViolation,
  resolveConfirmAfterGmailSourceConflict,
  runConfirmCreateTransaction,
} from "@/lib/booking/booking-confirm-idempotency"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BookingGmailMessageLifecycle,
  BOOKING_MISSING_ADDRESS_MAX_ATTEMPTS,
} from "@/lib/booking/gmail-message-lifecycle"
import type {
  BookingGmailMessageStatus,
  BookingGmailResultType,
  ProcessedGmailMessage,
} from "@prisma/client"

function aiClientReturning(
  content: Array<{ type: string; text?: string }>
): BookingAiClient {
  return {
    messages: {
      create: async () => ({ content }),
    },
  }
}

type Row = ProcessedGmailMessage

function makeFakeLifecycleDb() {
  const rows = new Map<string, Row>()
  const key = (companyId: string, messageId: string) => `${companyId}::${messageId}`
  const api = {
    processedGmailMessage: {
      async create({ data }: { data: Partial<Row> & { companyId: string; messageId: string } }) {
        const k = key(data.companyId, data.messageId)
        if (rows.has(k)) {
          throw Object.assign(new Error("Unique"), { code: "P2002" })
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
          errorCode: data.errorCode ?? null,
          errorMessage: data.errorMessage ?? null,
          resultType: (data.resultType as BookingGmailResultType) ?? null,
          resultEntityId: data.resultEntityId ?? null,
          succeededAt: data.succeededAt ?? null,
          updatedAt: new Date(),
        }
        rows.set(k, row)
        return row
      },
      async findUnique({
        where,
      }: {
        where: { companyId_messageId?: { companyId: string; messageId: string }; id?: string }
      }) {
        if (where.id) {
          for (const r of rows.values()) if (r.id === where.id) return r
          return null
        }
        const c = where.companyId_messageId!
        return rows.get(key(c.companyId, c.messageId)) ?? null
      },
      async findUniqueOrThrow(args: {
        where: { companyId_messageId?: { companyId: string; messageId: string }; id?: string }
      }) {
        const r = await api.processedGmailMessage.findUnique(args)
        if (!r) throw new Error("not found")
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
          if (where.OR && Array.isArray(where.OR)) {
            // ignore stale OR filters in unit fake when other fields match
          }
          const next = { ...row } as Row & Record<string, unknown>
          for (const [dk, dv] of Object.entries(data)) {
            if (dv && typeof dv === "object" && "increment" in (dv as object)) {
              next[dk] = (next[dk] as number) + (dv as { increment: number }).increment
            } else {
              next[dk] = dv as never
            }
          }
          rows.set(k, next as Row)
          count++
        }
        return { count }
      },
    },
  }
  return {
    api: api as unknown as ConstructorParameters<typeof BookingGmailMessageLifecycle>[0],
    rows,
    key,
  }
}

describe("htmlToPlainText — entités Booking", () => {
  it("1. décode &nbsp; et produit une adresse exploitable", () => {
    const html = "<p>Adresse : 74 Rue Robert&nbsp;Schuman</p>"
    const plain = htmlToPlainText(html)
    assert.ok(plain.includes("74 Rue Robert Schuman"))
    const parsed = regexFallbackParser(plain)
    assert.ok(parsed.address)
    assert.match(parsed.address!, /74\s+Rue\s+Robert\s+Schuman/i)
  })

  it("décode &amp;nbsp; imbriqué", () => {
    assert.equal(decodeHtmlEntities("74 Rue&amp;nbsp;X"), "74 Rue X")
    assert.ok(htmlToPlainText("<p>74 Rue&amp;nbsp;X</p>").includes("74 Rue X"))
  })

  it("extractNormalizedGmailBody décode le HTML payload", () => {
    const html = "Logement<br>74 Rue Robert&nbsp;Schuman"
    const b64 = Buffer.from(html, "utf8").toString("base64url")
    const text = extractNormalizedGmailBody({
      mimeType: "text/html",
      body: { data: b64 },
    })
    assert.ok(text.includes("74 Rue Robert Schuman"))
  })

  it("text/plain avec entité littérale", () => {
    const plain = "Adresse : 12 rue&nbsp;de la Paix"
    const b64 = Buffer.from(plain, "utf8").toString("base64url")
    const text = extractNormalizedGmailBody({
      mimeType: "text/plain",
      body: { data: b64 },
    })
    assert.ok(text.includes("12 rue de la Paix"))
  })
})

describe("extract — IA address null + regex", () => {
  it("2. JSON IA valide address=null → regex comble l’adresse", async () => {
    const email =
      "Confirmation Appartement Soleil\nAdresse : 12 rue de la Paix\nArrivée 20 juillet 2026\nDépart 25 juillet 2026"
    const emptyAddressJson = JSON.stringify({
      propertyName: "Appartement Soleil",
      address: null,
      city: null,
      zipCode: null,
      startDate: "2026-07-20",
      endDate: "2026-07-25",
      doorCode: null,
      contactName: null,
      contactPhone: null,
      notes: null,
      teamName: null,
    })
    const parsed = await extractBookingFields(
      email,
      "msg_ai_null_addr",
      aiClientReturning([{ type: "text", text: emptyAddressJson }])
    )
    assert.equal(parsed.propertyName, "Appartement Soleil")
    assert.equal(parsed.startDate, "2026-07-20")
    assert.ok(parsed.address)
    assert.match(parsed.address!, /12\s+rue\s+de\s+la\s+Paix/i)
  })

  it("plusieurs adresses : priorité au label Adresse :", () => {
    const text =
      "Expéditeur : 1 rue du Footer Spam\nAdresse : 42 rue du Logement Correct\nAutre : 99 avenue Ignorée"
    const parsed = regexFallbackParser(text)
    assert.match(parsed.address!, /42\s+rue\s+du\s+Logement\s+Correct/i)
    assert.ok(!parsed.address!.includes("Footer"))
  })

  it("mergeAiWithRegexFallback ne remplace pas une adresse IA", () => {
    const merged = mergeAiWithRegexFallback(
      {
        propertyName: null,
        address: "1 avenue IA",
        city: null,
        zipCode: null,
        startDate: null,
        endDate: null,
        doorCode: null,
        contactName: null,
        contactPhone: null,
        notes: null,
        teamName: null,
      },
      "12 rue de la Paix Paris"
    )
    assert.equal(merged.address, "1 avenue IA")
  })
})

describe("pending merge / confirm address", () => {
  it("3. pending sans adresse : rejeu enrichit", () => {
    const patch = buildPendingEnrichmentUpdate(
      {
        status: "PENDING",
        propertyName: "X",
        address: null,
        city: null,
        zipCode: null,
        startDate: new Date("2026-07-20"),
        endDate: new Date("2026-07-25"),
        doorCode: null,
        contactName: null,
        contactPhone: null,
        notes: null,
        rawEmailSnippet: "court",
      },
      {
        propertyName: "X",
        address: "12 rue de la Paix",
        city: "Paris",
        zipCode: "75002",
        startDate: "2026-07-20",
        endDate: "2026-07-25",
        doorCode: null,
        contactName: null,
        contactPhone: null,
        notes: null,
        teamName: null,
      },
      "corps riche ".repeat(80)
    )
    assert.ok(patch)
    assert.equal(patch!.address, "12 rue de la Paix")
  })

  it("4. pending avec adresse : rejeu address=null n’efface pas", () => {
    const patch = buildPendingEnrichmentUpdate(
      {
        status: "PENDING",
        propertyName: "X",
        address: "12 rue Validée",
        city: "Lyon",
        zipCode: null,
        startDate: null,
        endDate: null,
        doorCode: null,
        contactName: null,
        contactPhone: null,
        notes: null,
        rawEmailSnippet: null,
      },
      {
        propertyName: null,
        address: null,
        city: null,
        zipCode: "69001",
        startDate: "2026-08-01",
        endDate: "2026-08-05",
        doorCode: null,
        contactName: null,
        contactPhone: null,
        notes: null,
        teamName: null,
      }
    )
    assert.ok(patch)
    assert.equal(patch!.address, undefined)
    assert.equal(patch!.zipCode, "69001")
  })

  it("5. statut CONFIRMED : aucun enrichissement", () => {
    assert.equal(
      buildPendingEnrichmentUpdate(
        {
          status: "CONFIRMED",
          propertyName: "X",
          address: null,
          city: null,
          zipCode: null,
          startDate: null,
          endDate: null,
          doorCode: null,
          contactName: null,
          contactPhone: null,
          notes: null,
          rawEmailSnippet: null,
        },
        {
          propertyName: "Y",
          address: "99 rue Intruse",
          city: null,
          zipCode: null,
          startDate: null,
          endDate: null,
          doorCode: null,
          contactName: null,
          contactPhone: null,
          notes: null,
          teamName: null,
        }
      ),
      null
    )
  })

  it("M4 — DISMISSED : aucun enrichissement", () => {
    assert.equal(
      buildPendingEnrichmentUpdate(
        {
          status: "DISMISSED",
          propertyName: "X",
          address: null,
          city: null,
          zipCode: null,
          startDate: null,
          endDate: null,
          doorCode: null,
          contactName: null,
          contactPhone: null,
          notes: null,
          rawEmailSnippet: null,
        },
        {
          propertyName: "Y",
          address: "99 rue Intruse",
          city: null,
          zipCode: null,
          startDate: null,
          endDate: null,
          doorCode: null,
          contactName: null,
          contactPhone: null,
          notes: null,
          teamName: null,
        }
      ),
      null
    )
  })

  it("6. resolveConfirmAddress", () => {
    assert.equal(resolveConfirmAddress("12 rue A", undefined), "12 rue A")
    assert.equal(resolveConfirmAddress(null, " 99 rue B "), "99 rue B")
    assert.equal(resolveConfirmAddress(null, undefined), null)
  })

  it("hasBookingAddress", () => {
    assert.equal(hasBookingAddress({ address: "1 rue X" }), true)
    assert.equal(hasBookingAddress({ address: null }), false)
  })
})

describe("M1 — borne UI email preview", () => {
  it("jamais plus de 500 caractères transmis au client", () => {
    const rich = "Z".repeat(4000)
    const preview = toBookingUiEmailPreview(rich)
    assert.ok(preview)
    assert.equal(preview!.length, BOOKING_UI_EMAIL_PREVIEW_MAX)
    assert.equal(BOOKING_UI_EMAIL_PREVIEW_MAX, 500)
    assert.equal(rich.length, 4000)
  })

  it("null / court inchangé", () => {
    assert.equal(toBookingUiEmailPreview(null), null)
    assert.equal(toBookingUiEmailPreview("  hi  "), "hi")
  })
})

describe("autoProcess content selection", () => {
  it("7. préfère un contenu persisté riche", () => {
    const rich = "A".repeat(600)
    const picked = pickEmailTextForReprocess({
      propertyName: "Prop",
      persistedText: rich,
      gmailBody: null,
      snippetFallback: "snippet court",
    })
    assert.equal(picked.source, "persisted")
  })

  it("7b. sinon Gmail, sinon snippet", () => {
    assert.equal(
      pickEmailTextForReprocess({
        propertyName: null,
        persistedText: "court",
        gmailBody: "corps gmail 12 rue de la Paix",
        snippetFallback: "snippet",
      }).source,
      "gmail"
    )
  })
})

describe("M2 — MISSING_ADDRESS lifecycle", () => {
  let fake: ReturnType<typeof makeFakeLifecycleDb>
  let life: BookingGmailMessageLifecycle

  beforeEach(() => {
    process.env.BOOKING_GMAIL_MAX_ATTEMPTS = "5"
    process.env.BOOKING_GMAIL_PROCESSING_STALE_MS = String(15 * 60 * 1000)
    fake = makeFakeLifecycleDb()
    life = new BookingGmailMessageLifecycle(fake.api)
  })

  it("1ère absence → RETRYABLE / MISSING_ADDRESS", async () => {
    assert.equal(BOOKING_MISSING_ADDRESS_MAX_ATTEMPTS, 2)
    await life.claimForProcessing("coA", "msgMiss1")
    const failed = await life.markFailure({
      companyId: "coA",
      messageId: "msgMiss1",
      error: retryableBookingError("MISSING_ADDRESS", "Adresse absente"),
    })
    assert.equal(failed.status, "RETRYABLE_FAILURE")
    assert.equal(failed.errorCode, "MISSING_ADDRESS")
    assert.ok(failed.nextRetryAt)
  })

  it("2ᵉ absence → PERMANENTLY_IGNORED / ADDRESS_NOT_FOUND_AFTER_RETRY", async () => {
    await life.claimForProcessing("coA", "msgMiss2")
    await life.markFailure({
      companyId: "coA",
      messageId: "msgMiss2",
      error: retryableBookingError("MISSING_ADDRESS", "Adresse absente"),
      now: new Date("2026-07-20T10:00:00Z"),
    })
    const claim2 = await life.claimForProcessing(
      "coA",
      "msgMiss2",
      new Date("2026-07-20T11:00:00Z")
    )
    assert.equal(claim2.action, "CLAIMED")
    const failed2 = await life.markFailure({
      companyId: "coA",
      messageId: "msgMiss2",
      error: retryableBookingError("MISSING_ADDRESS", "Adresse absente"),
      now: new Date("2026-07-20T11:00:00Z"),
    })
    assert.equal(failed2.status, "PERMANENTLY_IGNORED")
    assert.equal(failed2.errorCode, "ADDRESS_NOT_FOUND_AFTER_RETRY")
    assert.equal(failed2.resultType, "IGNORED")
  })

  it("adresse trouvée au 2ᵉ passage → SUCCEEDED possible", async () => {
    await life.claimForProcessing("coA", "msgMiss3")
    await life.markFailure({
      companyId: "coA",
      messageId: "msgMiss3",
      error: retryableBookingError("MISSING_ADDRESS", "Adresse absente"),
      now: new Date("2026-07-20T10:00:00Z"),
    })
    const claim2 = await life.claimForProcessing(
      "coA",
      "msgMiss3",
      new Date("2026-07-20T11:00:00Z")
    )
    assert.equal(claim2.action, "CLAIMED")
    const ok = await life.markSucceededInTransaction(
      { companyId: "coA", messageId: "msgMiss3", now: new Date("2026-07-20T11:01:00Z") },
      async () => ({
        resultType: "PENDING_ACCOMMODATION" as const,
        resultEntityId: "pend1",
      }),
      {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            processedGmailMessage: fake!.api!.processedGmailMessage,
          }),
      } as never
    )
    assert.equal(ok.status, "SUCCEEDED")
  })

  it("classifie ADDRESS_NOT_FOUND_AFTER_RETRY en PERMANENT", () => {
    const c = classifyBookingError(new Error("ADDRESS_NOT_FOUND_AFTER_RETRY"))
    assert.equal(c.kind, "PERMANENT")
    assert.equal(c.code, "ADDRESS_NOT_FOUND_AFTER_RETRY")
  })
})

describe("M3-R2 — P2002 hors TX + résolution idempotente", () => {
  it("structure : isPrismaUniqueViolation n’apparaît PAS dans le callback $transaction de create", () => {
    const src = readFileSync(
      join(process.cwd(), "src/lib/booking/booking-confirm-idempotency.ts"),
      "utf8"
    )
    const createFn = src.slice(
      src.indexOf("export async function runConfirmCreateTransaction"),
      src.indexOf("export async function resolveConfirmAfterGmailSourceConflict")
    )
    assert.ok(createFn.includes("$transaction"))
    assert.ok(
      !createFn.includes("isPrismaUniqueViolation"),
      "P2002 ne doit pas être absorbé dans runConfirmCreateTransaction"
    )

    const coreSrc = readFileSync(
      join(process.cwd(), "src/lib/actions/gmail-pending-confirm.core.ts"),
      "utf8"
    )
    const confirmFn = coreSrc.slice(
      coreSrc.indexOf("export async function confirmPendingAccommodationImpl"),
      coreSrc.length
    )
    // Catch P2002 après await runConfirmCreateTransaction — pas dans un try interne au callback tx
    assert.ok(confirmFn.includes("runConfirmCreateTransaction"))
    assert.ok(confirmFn.includes("resolveConfirmAfterGmailSourceConflict"))
    const createCallIdx = confirmFn.indexOf("await runConfirmCreateTransaction")
    const catchIdx = confirmFn.indexOf("isPrismaUniqueViolation", createCallIdx)
    assert.ok(catchIdx > createCallIdx, "catch P2002 doit être après l’appel TX create")

    const façade = readFileSync(
      join(process.cwd(), "src/lib/actions/gmail.actions.ts"),
      "utf8"
    )
    assert.ok(façade.includes("confirmPendingAccommodationImpl"))
  })

  it("reconnaît gmailSourceMessageId ; refuse autre contrainte / meta absente", () => {
    assert.equal(
      isPrismaUniqueViolation(
        { code: "P2002", meta: { target: ["companyId", "gmailSourceMessageId"] } },
        ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS
      ),
      true
    )
    assert.equal(
      isPrismaUniqueViolation(
        { code: "P2002", meta: { target: "accommodations_companyId_gmailSourceMessageId_key" } },
        ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS
      ),
      true
    )
    assert.equal(
      isPrismaUniqueViolation(
        { code: "P2002", meta: { target: ["bookingReference"] } },
        ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS
      ),
      false
    )
    assert.equal(isAnyPrismaUniqueViolation({ code: "P2002", meta: { target: ["x"] } }), true)
  })

  it("P2002 ciblé : résolution dans nouveau contexte → pending CONFIRMED, idempotent", async () => {
    const state = {
      accommodations: [
        {
          id: "acc1",
          companyId: "coA",
          gmailSourceMessageId: "msg1",
          createdAt: new Date(),
        },
      ],
      pendings: [
        {
          id: "pend1",
          companyId: "coA",
          status: "PENDING" as const,
          accommodationId: null as string | null,
          confirmedById: null as string | null,
          confirmedAt: null as Date | null,
        },
      ],
      txCalls: 0,
    }

    const fakeDb = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        state.txCalls++
        const tx = {
          accommodation: {
            findFirst: async ({
              where,
            }: {
              where: { companyId: string; gmailSourceMessageId: string }
            }) =>
              state.accommodations.find(
                (a) =>
                  a.companyId === where.companyId &&
                  a.gmailSourceMessageId === where.gmailSourceMessageId
              ) ?? null,
          },
          pendingAccommodation: {
            findFirst: async ({
              where,
            }: {
              where: { id: string; companyId: string }
            }) =>
              state.pendings.find(
                (p) => p.id === where.id && p.companyId === where.companyId
              ) ?? null,
            updateMany: async ({
              where,
              data,
            }: {
              where: { id: string; companyId: string; status: string }
              data: Record<string, unknown>
            }) => {
              const p = state.pendings.find(
                (x) =>
                  x.id === where.id &&
                  x.companyId === where.companyId &&
                  x.status === where.status
              )
              if (!p) return { count: 0 }
              Object.assign(p, data)
              return { count: 1 }
            },
          },
        }
        return fn(tx)
      },
    }

    const result = await resolveConfirmAfterGmailSourceConflict(fakeDb as never, {
      companyId: "coA",
      userId: "u1",
      pendingId: "pend1",
      gmailMessageId: "msg1",
    })
    assert.deepEqual(result, { success: true, idempotent: true })
    assert.equal(state.pendings[0]!.status, "CONFIRMED")
    assert.equal(state.pendings[0]!.accommodationId, "acc1")
    assert.equal(state.txCalls, 1)
  })

  it("Accommodation autre tenant → refus", async () => {
    const fakeDb = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn({
          accommodation: {
            findFirst: async () => ({
              id: "accX",
              companyId: "coOTHER",
              gmailSourceMessageId: "msg1",
            }),
          },
          pendingAccommodation: {
            findFirst: async () => null,
            updateMany: async () => {
              throw new Error("ne doit pas update")
            },
          },
        })
      },
    }
    const result = await resolveConfirmAfterGmailSourceConflict(fakeDb as never, {
      companyId: "coA",
      userId: "u1",
      pendingId: "pend1",
      gmailMessageId: "msg1",
    })
    assert.equal("error" in result, true)
    if ("error" in result) {
      assert.match(result.error, /isolation|introuvable/i)
    }
  })

  it("Pending déjà CONFIRMED → succès idempotent", async () => {
    const fakeDb = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn({
          accommodation: {
            findFirst: async () => ({
              id: "acc1",
              companyId: "coA",
              gmailSourceMessageId: "msg1",
            }),
          },
          pendingAccommodation: {
            findFirst: async () => ({
              id: "pend1",
              companyId: "coA",
              status: "CONFIRMED",
            }),
            updateMany: async () => {
              throw new Error("ne doit pas update")
            },
          },
        })
      },
    }
    const result = await resolveConfirmAfterGmailSourceConflict(fakeDb as never, {
      companyId: "coA",
      userId: "u1",
      pendingId: "pend1",
      gmailMessageId: "msg1",
    })
    assert.deepEqual(result, { success: true, idempotent: true })
  })

  it("Pending DISMISSED → aucune réactivation", async () => {
    const fakeDb = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn({
          accommodation: {
            findFirst: async () => ({
              id: "acc1",
              companyId: "coA",
              gmailSourceMessageId: "msg1",
            }),
          },
          pendingAccommodation: {
            findFirst: async () => ({
              id: "pend1",
              companyId: "coA",
              status: "DISMISSED",
            }),
            updateMany: async () => {
              throw new Error("ne doit pas update")
            },
          },
        })
      },
    }
    const result = await resolveConfirmAfterGmailSourceConflict(fakeDb as never, {
      companyId: "coA",
      userId: "u1",
      pendingId: "pend1",
      gmailMessageId: "msg1",
    })
    assert.equal("error" in result, true)
    if ("error" in result) {
      assert.match(result.error, /ignorée/i)
    }
  })

  it("runConfirmCreateTransaction laisse remonter P2002 (pas d’absorption interne)", async () => {
    const p2002 = Object.assign(new Error("Unique"), {
      code: "P2002",
      meta: { target: ["gmailSourceMessageId"] },
    })
    const fakeDb = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        const tx = {
          accommodation: {
            create: async () => {
              throw p2002
            },
          },
          pendingAccommodation: {
            updateMany: async () => {
              throw new Error("ne doit pas être appelé après create P2002")
            },
          },
          notification: {
            createMany: async () => {
              throw new Error("ne doit pas notifier")
            },
          },
        }
        return fn(tx)
      },
    }
    await assert.rejects(
      () =>
        runConfirmCreateTransaction(fakeDb as never, {
          companyId: "coA",
          userId: "u1",
          pendingId: "pend1",
          gmailMessageId: "msg1",
          teamId: "t1",
          finalAddress: "12 rue X",
          city: null,
          zipCode: null,
          doorCode: null,
          contactName: null,
          contactPhone: null,
          notes: null,
          startDate: new Date("2026-08-01"),
          endDate: new Date("2026-08-05"),
          notifyUserIds: [],
          teamName: "Équipe",
          startLabel: "a",
          endLabel: "b",
        }),
      (err: unknown) => isPrismaUniqueViolation(err, ACCOMMODATION_GMAIL_SOURCE_UNIQUE_HINTS)
    )
  })

  it("double résolution logique : un seul Accommodation, résultat stable", async () => {
    const state = {
      accommodations: [
        { id: "acc1", companyId: "coA", gmailSourceMessageId: "msg1", createdAt: new Date() },
      ],
      pendings: [
        {
          id: "pend1",
          companyId: "coA",
          status: "PENDING" as string,
          accommodationId: null as string | null,
          confirmedById: null as string | null,
          confirmedAt: null as Date | null,
        },
      ],
    }
    const fakeDb = {
      async $transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn({
          accommodation: {
            findFirst: async () => state.accommodations[0],
          },
          pendingAccommodation: {
            findFirst: async () => state.pendings[0],
            updateMany: async ({
              where,
              data,
            }: {
              where: { status: string }
              data: Record<string, unknown>
            }) => {
              if (state.pendings[0]!.status !== where.status) return { count: 0 }
              Object.assign(state.pendings[0]!, data)
              return { count: 1 }
            },
          },
        })
      },
    }
    const r1 = await resolveConfirmAfterGmailSourceConflict(fakeDb as never, {
      companyId: "coA",
      userId: "u1",
      pendingId: "pend1",
      gmailMessageId: "msg1",
    })
    const r2 = await resolveConfirmAfterGmailSourceConflict(fakeDb as never, {
      companyId: "coA",
      userId: "u1",
      pendingId: "pend1",
      gmailMessageId: "msg1",
    })
    assert.deepEqual(r1, { success: true, idempotent: true })
    assert.deepEqual(r2, { success: true, idempotent: true })
    assert.equal(state.accommodations.length, 1)
    assert.equal(state.pendings[0]!.status, "CONFIRMED")
  })
})

describe("M4 — Gmail body inaccessible / isolation", () => {
  it("token/connexion absente → échec sans fuite de secret", async () => {
    const res = await fetchBookingGmailMessageBody("coTenantA", "msgX", {
      getAccessToken: async () => {
        throw Object.assign(new Error("GMAIL_NOT_CONNECTED"), {
          code: "GMAIL_NOT_CONNECTED",
          retryable: false,
        })
      },
      fetchImpl: async () => {
        throw new Error("should not fetch")
      },
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, "GMAIL_NOT_CONNECTED")
      assert.ok(!/bearer|ya29|sk-ant/i.test(res.message))
    }
  })

  it("HTTP 404 → non retryable, message sans token", async () => {
    const res = await fetchBookingGmailMessageBody("coA", "msgDeleted", {
      getAccessToken: async (companyId) => {
        assert.equal(companyId, "coA")
        return "tok_secret_should_not_leak"
      },
      fetchImpl: async (_url, init) => {
        const auth = (init as RequestInit)?.headers
        // Token used for auth but never returned in result.message
        void auth
        return new Response(null, { status: 404 })
      },
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.retryable, false)
      assert.equal(res.message, "Gmail get HTTP 404")
      assert.ok(!res.message.includes("tok_secret"))
    }
  })

  it("isolation : getAccessToken reçoit uniquement le companyId demandé", async () => {
    const seen: string[] = []
    await fetchBookingGmailMessageBody("coOnly", "m1", {
      getAccessToken: async (companyId) => {
        seen.push(companyId)
        return "t"
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ snippet: "ok body text for fallback path" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    })
    assert.deepEqual(seen, ["coOnly"])
  })
})
