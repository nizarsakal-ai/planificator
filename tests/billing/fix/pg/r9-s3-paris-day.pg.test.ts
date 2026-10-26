// S3 (revue Codex R2, 26/10/2026) — date d'émission et série annuelle = jour civil Europe/Paris à l'instant de décision (relu après
// les verrous), pour les factures, acomptes et avoirs. Reproduction Codex : émission à 2026-12-31T23:30:00Z (1er janvier 2027 00:30
// Paris) ⇒ FAC-2027-0001, issueDate 2027-01-01 (plus jamais FAC-2026 / 31 décembre). Minuit Paris hiver/été, avoir partiel (série AV),
// avoir total Lot B, attente de verrou franchissant minuit (horloge ancrée + temps réel écoulé), échéance = émission + délai.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { businessDay, businessYear } from "@/lib/billing/business-day"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { A, NOW, holdTransaction, js, seedCompanies, useTestClock, waitFor, waitingSessions } from "./helpers"

const db = new PrismaClient(), db2 = new PrismaClient()
const L = [{ designation: "Travaux", quantity: "1", unitPrice: "1000", vatRate: "20" }]
async function draft() { const f = parseInvoiceForm({ worksiteId: "wA", lines: L }); if (!f.ok) throw new Error(f.error); const d = await createDraftInvoice(db, A, f.value, NOW); if (!d.ok) throw new Error(d.error); return d.value.id }
const row = (id: string) => db.invoice.findUniqueOrThrow({ where: { id }, select: { number: true, issueDate: true, dueDate: true, sentAt: true, status: true } })
const iso = (d: Date | null) => d?.toISOString().slice(0, 10)

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); setBillingClockForTests(() => NOW); await db.$disconnect(); await db2.$disconnect() })

describe("S3 — jour métier Europe/Paris pour la date et la série", () => {
  it("reproduction Codex : 2026-12-31T23:30Z ⇒ FAC-2027-0001, issueDate 2027-01-01, échéance 2027-01-31 ; 22:59Z la même nuit ⇒ FAC-2026, 2026-12-31", async () => {
    const late = new Date("2026-12-31T23:30:00Z"), early = new Date("2026-12-31T22:59:00Z")
    const a = await draft(); const ra = await issueInvoice(db, A, a, early, () => early); assert.ok(ra.ok, js(ra))
    const b = await draft(); const rb = await issueInvoice(db, A, b, late, () => late); assert.ok(rb.ok, js(rb))
    const A1 = await row(a), B1 = await row(b)
    assert.equal(A1.number, "FAC-2026-0001"); assert.equal(iso(A1.issueDate), "2026-12-31"); assert.equal(iso(A1.dueDate), "2027-01-30")
    assert.equal(B1.number, "FAC-2027-0001"); assert.equal(iso(B1.issueDate), "2027-01-01"); assert.equal(iso(B1.dueDate), "2027-01-31")
    assert.equal(B1.sentAt?.toISOString(), late.toISOString(), "sentAt = instant de décision")
    // Été : 2026-06-30T22:30Z = 1er juillet 00:30 Paris (UTC+2).
    const c = await draft(); const summer = new Date("2026-06-30T22:30:00Z"); assert.ok((await issueInvoice(db, A, c, summer, () => summer)).ok)
    assert.equal(iso((await row(c)).issueDate), "2026-07-01")
    assert.equal(businessDay(new Date("2026-06-30T21:59:59Z")).toISOString(), "2026-06-30T00:00:00.000Z"); assert.equal(businessYear(late), 2027)
  })
  it("avoir partiel (série AV) et avoir total Lot B : 2026-12-31T23:30Z ⇒ AV-2027-0001 / AV-2027-0002, issueDate 2027-01-01", async () => {
    const late = new Date("2026-12-31T23:30:00Z")
    setBillingClockForTests(() => late) // horloge serveur relue après verrou = la même nuit
    const a = await draft(); assert.ok((await issueInvoice(db, A, a, late)).ok)
    const cn = await createPartialCreditNote(db, A, a, { kind: "AMOUNT_HT", cents: BigInt(10000) }, "remise de fin d'année", late); assert.ok(cn.ok, js(cn)); if (!cn.ok) return
    const n1 = await row(cn.value.id); assert.equal(n1.number, "AV-2027-0001"); assert.equal(iso(n1.issueDate), "2027-01-01")
    const b = await draft(); assert.ok((await issueInvoice(db, A, b, late)).ok)
    const t = await db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: b, actorId: "admA", reason: null, now: late, nextNumber: (x, at) => nextDocumentNumber(x, "coA", "CREDIT_NOTE", businessYear(at)) }); if (r.ok) await flushDeferredConstraints(tx); return r }); assert.ok(t.ok, js(t)); if (!t.ok) return
    const n2 = await row(t.value.id); assert.equal(n2.number, "AV-2027-0002"); assert.equal(iso(n2.issueDate), "2027-01-01")
    setBillingClockForTests(() => NOW)
    void recordPayment
  })
  it("attente de verrou franchissant minuit Paris : décision démarrée le 31/12 à 23:59:59,8 Paris, verrou tenu 400 ms ⇒ émise le 1er janvier dans la série 2027", async () => {
    const id = await draft()
    const t0 = new Date("2026-12-31T22:59:59.800Z"); const anchor = Date.now()
    const clock = () => new Date(t0.getTime() + (Date.now() - anchor))
    const h = await holdTransaction(db2); await h.tx.$queryRawUnsafe(`SELECT 1 FROM invoices WHERE id = '${id}' FOR UPDATE`)
    const issuing = issueInvoice(db, A, id, clock(), clock)
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); await new Promise((r) => setTimeout(r, 400)); await h.commit()
    const r = await issuing; assert.ok(r.ok, js(r))
    const inv = await row(id); assert.equal(iso(inv.issueDate), "2027-01-01"); assert.match(inv.number, /^FAC-2027-/)
  })
})
