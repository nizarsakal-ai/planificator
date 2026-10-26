// R5 (revue Codex R2, 26/10/2026) — une situation hors contrat fiscal (avertissement du calcul) REFUSE l'enregistrement de la
// déclaration ; rien n'est figé ; l'action réelle (session simulée) refuse aussi ; une déclaration enregistrée archive le contrôle
// (details.warnings = [], outOfContractChecked). Reproduction Codex : facture 120 € payée puis annulée par avoir total ⇒ warning ⇒
// declareVat ok=false, aucune ligne DECLARED. Même famille : la déclaration est calculée et écrite dans un instantané cohérent
// (SERIALIZABLE, rejouée sur conflit) — un paiement committé pendant le calcul n'entre pas dans la déclaration figée ; périodes identiques refusées.
import assert from "node:assert/strict"
import { after, before, describe, it, mock } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { computeVat } from "@/lib/accounting/c5/vat"
import { VAT_DECLARATION_ERRORS, declareVat } from "@/lib/accounting/c5/vat-declaration"
import { A, B, D, NOW, holdTransaction, js, seedCompanies, waitFor, waitingSessions, useTestClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient(), db2 = new PrismaClient()
process.env.BILLING_COMPLETE_ENABLED = "true"; process.env.ACCOUNTING_MODULE_ENABLED = "true"
mock.module("@/lib/prisma", { namedExports: { prisma: db } })
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } })
mock.module("@/lib/accounting/access/accounting-access", { namedExports: { requireAccountingAdmin: async () => ({ companyId: "coA", userId: "admA", role: "ADMIN" }), resolveAccountingAccessForRequest: async () => ({ ok: false, reason: "TEST" }) } })
const MAR = [D("2026-03-01"), D("2026-03-31")] as const, APR = [D("2026-04-01"), D("2026-04-30")] as const
const pay = (ctx: typeof A, inv: string, cents: number, day: string) => recordPayment(db, ctx, inv, { amountCents: BigInt(cents), method: "TRANSFER", paidAt: D(day), reference: null, notes: null }, new Date(`${day}T12:00:00Z`)).then((r) => { if (!r.ok) throw new Error(r.error); return r.value })
const inv120 = (ctx: typeof A, w: string, day: string) => issuedInvoice(db, ctx, w, [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date(`${day}T10:00:00Z`) })

before(async () => { setBillingMailerForTests(new RecordingMailer()); useTestClock(new Date("2026-10-26T10:00:00Z")); await seedCompanies(db) }) // horloge postérieure aux périodes déclarées (C1)
after(async () => { setBillingMailerForTests(null); await db.$disconnect(); await db2.$disconnect() })

describe("R5 — refus explicite d'une déclaration comportant un cas hors contrat", () => {
  it("reproduction Codex : facture payée puis avoir total ⇒ avertissement ⇒ declareVat refuse en citant l'avertissement ; aucune déclaration, aucun journal", async () => {
    const inv = await inv120(A, "wA", "2026-03-02")
    await pay(A, inv, 12000, "2026-03-12")
    await db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: inv, actorId: "admA", reason: "Test avoir total", now: new Date("2026-03-15T10:00:00Z"), nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) }); if (!r.ok) throw new Error(r.error); await flushDeferredConstraints(tx) })
    const v = await computeVat(db, A, MAR[0], MAR[1], "ENCAISSEMENTS"); assert.equal(v.warnings.length, 1, js(v.warnings))
    const r = await declareVat(db, A, MAR[0], MAR[1], "ENCAISSEMENTS")
    assert.equal(r.ok, false); assert.ok((r as { error: string }).error.startsWith(VAT_DECLARATION_ERRORS.outOfContract), js(r)); assert.ok((r as { error: string }).error.includes(v.warnings[0]))
    assert.equal(await db.vatDeclaration.count({ where: { companyId: "coA" } }), 0); assert.equal(await db.historyLog.count({ where: { companyId: "coA", entityType: "VatDeclaration" } }), 0)
    // Action réelle (session simulée) : même refus, même message ; rien d'écrit.
    const { declareVatAction } = await import("@/lib/actions/accounting-c5.actions")
    const act = await declareVatAction({ periodStart: "2026-03-01", periodEnd: "2026-03-31", basis: "ENCAISSEMENTS" })
    assert.equal(act.ok, false); assert.match((act as { error: string }).error, /hors contrat fiscal/)
    assert.equal(await db.vatDeclaration.count({ where: { companyId: "coA" } }), 0)
  })
  it("déclaration sans cas hors contrat (DÉBITS, même période) : enregistrée, contrôle archivé (warnings = [], outOfContractChecked) ; société B non concernée enregistre normalement", async () => {
    const d = await declareVat(db, A, MAR[0], MAR[1], "DEBITS"); assert.ok(d.ok, js(d)); if (!d.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: d.value.id } })
    assert.equal(stored.status, "DECLARED"); assert.deepEqual((stored.details as { warnings: string[] }).warnings, []); assert.equal((stored.details as { outOfContractChecked: boolean }).outOfContractChecked, true); assert.equal((stored.details as { adjustments: number }).adjustments, 0)
    const invB = await inv120(B, "wB", "2026-03-02"); await pay(B, invB, 12000, "2026-03-12")
    const b = await declareVat(db, B, MAR[0], MAR[1], "ENCAISSEMENTS"); assert.ok(b.ok && b.value.dueCents === BigInt(2000), js(b))
  })
  it("même famille : instantané cohérent (SERIALIZABLE) — un paiement committé APRÈS la première lecture de la déclaration n'entre pas dans la déclaration figée ; rejeu de la période refusé", async () => {
    const inv = await inv120(A, "wA", "2026-04-02"); await pay(A, inv, 6000, "2026-04-05")
    const inv2 = await inv120(A, "wA", "2026-04-02")
    // Barrière déterministe : le client utilisé par la déclaration est étendu pour SUSPENDRE après sa première lecture (l'instantané
    // SERIALIZABLE est alors pris) ; la session 2 committe un paiement de 120 € sur inv2 pendant cette suspension ; la déclaration reprend.
    let release!: () => void; const gate = new Promise<void>((r) => { release = r }); let paused = false
    const hooked = db.$extends({ query: { vatDeclaration: { async findFirst({ args, query }) { const r = await query(args); paused = true; await gate; return r } } } }) as unknown as PrismaClient
    const declaring = declareVat(hooked, A, APR[0], APR[1], "ENCAISSEMENTS")
    assert.ok(await waitFor(async () => paused), "la déclaration a pris son instantané et attend")
    const p2 = await pay(A, inv2, 12000, "2026-04-06"); assert.equal(p2.status, "PAID") // committé pendant la suspension
    release()
    const r = await declaring; assert.ok(r.ok, js(r)); if (!r.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: r.value.id } })
    assert.equal(stored.collectedCents, BigInt(1000), "déclaration = instantané antérieur au paiement concurrent (60 € encaissés ⇒ 10 €)")
    assert.equal((stored.details as { payments: number }).payments, 1)
    const after = await computeVat(db, A, APR[0], APR[1], "ENCAISSEMENTS"); assert.equal(after.collectedCents, BigInt(3000), "le recalcul courant voit les deux paiements")
    assert.deepEqual(await declareVat(db, A, APR[0], APR[1], "ENCAISSEMENTS"), { ok: false, error: VAT_DECLARATION_ERRORS.alreadyDeclared })
    void waitingSessions; void holdTransaction; void db2; void NOW
  })
})
