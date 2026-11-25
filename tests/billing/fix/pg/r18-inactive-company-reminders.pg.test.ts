// Cycle R18 — retrait de sociétés (NOHISAC, Noisac Structures) : une société DÉSACTIVÉE (`Company.active = false`, via
// `toggleCompanyActive`) ne doit plus déclencher aucun courrier automatique en son nom. Relances de factures J+30/45/60, relances de
// devis J+3/7/15 et expiration automatique des devis : filtre `company.active` à la sélection ET à la réclamation conditionnelle
// (une désactivation committée entre la lecture et la réclamation l'emporte). Une société active continue d'être relancée.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { runInvoiceReminders } from "@/lib/billing/invoices/invoice.service"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { createQuote, runQuoteReminders, sendQuote } from "@/lib/billing/quotes/quote.service"
import { A, B, NOW, seedCompanies, useTestClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const mailer = new RecordingMailer()
const LINES = [{ designation: "Prestation", quantity: "1", unitPrice: "100", vatRate: "20" }]
const TO_A = "client-a@example.test", TO_B = "client-b@example.test"
const sentTo = (to: string, from: number) => mailer.sent.slice(from).filter((m) => m.to === to).length
const setActive = (companyId: string, active: boolean) => db.company.update({ where: { id: companyId }, data: { active } })

/** Client dont le N-ième `findMany` du modèle désactive la société B juste APRÈS la lecture : simule une désactivation entre lecture et réclamation. */
function deactivateBAfterFindMany(model: "invoice" | "quote", nth: number): PrismaClient {
  let calls = 0
  // Modèle choisi dynamiquement : le typage générique de `$extends` ne s'applique pas, on passe par un appel non typé.
  const extend = db.$extends.bind(db) as unknown as (ext: unknown) => unknown
  return extend({
    query: {
      [model]: {
        async findMany({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) {
          const rows = await query(args)
          if (++calls === nth) await setActive(B.companyId, false)
          return rows
        },
      },
    },
  }) as PrismaClient
}

async function sentQuote(ctx: { companyId: string; userId: string }, worksiteId: string, validUntil: string): Promise<string> {
  const p = parseQuoteForm({ worksiteId, issueDate: NOW.toISOString().slice(0, 10), validUntil, lines: LINES, globalDiscount: "", vatReverseCharge: false })
  if (!p.ok) throw new Error(p.error)
  const q = await createQuote(db, ctx, p.value); if (!q.ok) throw new Error(q.error)
  const s = await sendQuote(db, ctx, q.value.id, NOW, () => NOW); if (!s.ok) throw new Error(s.error)
  return q.value.id
}

before(async () => { useTestClock(); setBillingMailerForTests(mailer); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("R18 — relances de factures : société désactivée ignorée", () => {
  it("facture échue d'une société inactive : aucun courrier, aucun palier consommé ; société active relancée", async () => {
    const invA = await issuedInvoice(db, A, "wA", LINES)
    const invB = await issuedInvoice(db, B, "wB", LINES)
    await setActive(B.companyId, false)
    const from = mailer.sent.length
    const late = new Date(NOW.getTime() + 120 * 86_400_000)
    const r = await runInvoiceReminders(db, late)
    assert.ok(r.reminders.every((x) => x.sent >= 1), JSON.stringify(r))
    assert.ok(sentTo(TO_A, from) >= 1, "la société active doit être relancée")
    assert.equal(sentTo(TO_B, from), 0, "aucune relance au nom d'une société désactivée")
    const b = await db.invoice.findUniqueOrThrow({ where: { id: invB } })
    assert.deepEqual([b.reminderDue30SentAt, b.reminderDue45SentAt, b.reminderDue60SentAt], [null, null, null])
    const a = await db.invoice.findUniqueOrThrow({ where: { id: invA } })
    assert.ok(a.reminderDue30SentAt && a.reminderDue45SentAt && a.reminderDue60SentAt)
    // Réactivation : les relances reprennent (le filtre ne « brûle » aucun palier).
    await setActive(B.companyId, true)
    const from2 = mailer.sent.length
    await runInvoiceReminders(db, late)
    assert.ok(sentTo(TO_B, from2) >= 1)
    assert.equal(sentTo(TO_A, from2), 0, "idempotence : pas de second courrier pour A")
  })

  it("désactivation committée entre la lecture et la réclamation : la réclamation échoue, aucun courrier", async () => {
    const invB = await issuedInvoice(db, B, "wB", LINES)
    const from = mailer.sent.length
    // Les trois paliers sont dus ; B est désactivée juste après la lecture du palier J+30 (premier findMany).
    await runInvoiceReminders(deactivateBAfterFindMany("invoice", 1), new Date(NOW.getTime() + 120 * 86_400_000))
    assert.equal(sentTo(TO_B, from), 0)
    const b = await db.invoice.findUniqueOrThrow({ where: { id: invB } })
    assert.deepEqual([b.reminderDue30SentAt, b.reminderDue45SentAt, b.reminderDue60SentAt], [null, null, null])
    await setActive(B.companyId, true)
  })
})

describe("R18 — devis : relances et expiration automatique ignorées pour une société désactivée", () => {
  it("société inactive : ni relance ni expiration ; société active : relance et expiration", async () => {
    const qA = await sentQuote(A, "wA", "2026-12-31"), qxA = await sentQuote(A, "wA", "2026-03-12")
    const qB = await sentQuote(B, "wB", "2026-12-31"), qxB = await sentQuote(B, "wB", "2026-03-12")
    await setActive(B.companyId, false)
    const from = mailer.sent.length
    const r = await runQuoteReminders(db, new Date("2026-03-20T10:00:00Z"))
    assert.equal(r.expired, 1, JSON.stringify(r))
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: qxA } })).status, "EXPIRED")
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: qxB } })).status, "SENT")
    assert.equal(sentTo(TO_A, from), 1)
    assert.equal(sentTo(TO_B, from), 0)
    assert.ok((await db.quote.findUniqueOrThrow({ where: { id: qA } })).reminderJ7SentAt)
    const b = await db.quote.findUniqueOrThrow({ where: { id: qB } })
    assert.deepEqual([b.reminderJ3SentAt, b.reminderJ7SentAt, b.reminderJ15SentAt], [null, null, null])
    await setActive(B.companyId, true)
  })

  it("désactivation committée entre la sélection des relances et la réclamation : aucun courrier", async () => {
    const qB = await sentQuote(B, "wB", "2026-12-31")
    const from = mailer.sent.length
    // 1er findMany = devis à expirer, 2e = candidats aux relances : B est désactivée juste après la lecture des candidats.
    await runQuoteReminders(deactivateBAfterFindMany("quote", 2), new Date("2026-03-14T10:00:00Z"))
    assert.equal(sentTo(TO_B, from), 0)
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: qB } })).reminderJ3SentAt, null)
    await setActive(B.companyId, true)
  })
})
