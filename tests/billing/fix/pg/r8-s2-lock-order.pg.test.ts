// S2 (revue Codex R2, 26/10/2026) — ordre global des verrous DEVIS → FACTURE → ACOMPTES pour l'émission d'un acompte ET d'une
// facture de solde. Reproduction Codex : acompte DRAFT et solde du même devis émis concurremment ⇒ plus de 40P01 : les deux
// émissions se sérialisent sur le devis ; la seconde est refusée explicitement (acompte brouillon ⇒ « émettez-le ou abandonnez-le » ;
// solde émis ⇒ « plus d'acompte possible »). Deux connexions, barrières explicites (verrou tenu, attente observée, commit), dans les
// deux ordres ; chemin réel issueInvoice. Défense en profondeur : rejeu borné sur P2034 (withLockRetry).
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { issueInvoice, lockInvoiceRow, updateDraftInvoice, withLockRetry } from "@/lib/billing/invoices/invoice.service"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { issueInvoiceCore, INVOICE_C2_ERRORS } from "@/lib/billing/invoices/invoice-c2.core"
import { DEPOSIT_ERRORS, createDepositInvoice, depositIssueChecks } from "@/lib/billing/invoices/deposit.service"
import { lockQuoteRow } from "@/lib/billing/quotes/quote.service"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { A, NOW, holdTransaction, js, seedCompanies, useTestClock, waitFor, waitingOnTable, waitingSessions } from "./helpers"
import { acceptedQuote, finalDraft } from "./fixtures"

const db = new PrismaClient(), db2 = new PrismaClient()
const L = [{ designation: "Travaux", quantity: "1", unitPrice: "1000", vatRate: "20" }]
const coreIssue = (tx: Parameters<typeof issueInvoiceCore>[0], id: string) => issueInvoiceCore(tx, { companyId: "coA", invoiceId: id, actorId: "admA", now: NOW, paymentTermsDays: 30, nextLegalNumber: (t, y) => nextDocumentNumber(t, "coA", "INVOICE", y), lockInvoice: lockInvoiceRow, lockQuote: lockQuoteRow, extraChecks: (t, inv) => depositIssueChecks(t, "coA", inv) })
const status = (id: string) => db.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, number: true } })

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect(); await db2.$disconnect() })

describe("S2 — émissions concurrentes acompte DRAFT / solde : sérialisées, jamais 40P01", () => {
  it("reproduction Codex (cœurs réels, deux connexions) : l'émission de l'acompte tient devis+acompte ; l'émission du solde attend le devis ; après commit, le solde est refusé (acompte émis non déduit) — aucune exception", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    const cd = await createDepositInvoice(db, A, q, { kind: "PERCENT", bp: 3000 }, NOW); assert.ok(cd.ok); if (!cd.ok) return
    const fin = await finalDraft(db, A, q) // le brouillon de solde ne déduit pas l'acompte encore brouillon
    const a = await holdTransaction(db2)
    const depIssue = await coreIssue(a.tx, cd.value.id); assert.ok(depIssue.ok, js(depIssue)) // tient devis → acompte
    let settled = false
    const finIssue = issueInvoice(db, A, fin, NOW).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "le solde attend"); assert.equal(await waitingOnTable(db, "quotes"), 1, "… sur le verrou du DEVIS (premier verrou, avant la facture)"); assert.equal(settled, false)
    await a.commit()
    assert.deepEqual(await finIssue, { ok: false, error: DEPOSIT_ERRORS.depositNotDeducted })
    assert.equal((await status(cd.value.id)).status, "SENT"); assert.equal((await status(fin)).status, "DRAFT")
  })
  it("ordre inverse : le solde (refusé : acompte brouillon) tient devis+facture+acomptes ; l'émission de l'acompte attend le devis puis réussit ; le solde recalculé s'émet ensuite à 840 € — aucune exception", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    const cd = await createDepositInvoice(db, A, q, { kind: "PERCENT", bp: 3000 }, NOW); assert.ok(cd.ok); if (!cd.ok) return
    const fin = await finalDraft(db, A, q)
    const b = await holdTransaction(db2)
    const finIssue = await coreIssue(b.tx, fin) // tient devis → facture → acomptes ; refus explicite (acompte encore brouillon), transaction encore ouverte
    assert.deepEqual(finIssue, { ok: false, error: DEPOSIT_ERRORS.depositDraft })
    let settled = false
    const depIssue = issueInvoice(db, A, cd.value.id, NOW).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "l'acompte attend"); assert.equal(await waitingOnTable(db, "quotes"), 1, "… sur le verrou du DEVIS"); assert.equal(settled, false)
    await b.commit()
    const d = await depIssue; assert.ok(d.ok, js(d))
    assert.equal((await status(cd.value.id)).status, "SENT"); assert.equal((await status(fin)).status, "DRAFT")
    // Le solde : refusé tant que l'acompte émis n'est pas déduit ; après recalcul (même devis), émis à 1 200 − 360 = 840 €.
    assert.deepEqual(await issueInvoice(db, A, fin, NOW), { ok: false, error: DEPOSIT_ERRORS.depositNotDeducted })
    const f = parseInvoiceForm({ worksiteId: "wA", quoteId: q, lines: L }); assert.ok(f.ok); if (!f.ok) return
    assert.ok((await updateDraftInvoice(db, A, fin, f.value)).ok)
    const iss = await issueInvoice(db, A, fin, NOW); assert.ok(iss.ok, js(iss))
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: fin } })).totalTTC.toString(), "840")
  })
  it("défense en profondeur : withLockRetry rejoue une transaction victime d'interblocage (P2034, ou P2010 avec SQLSTATE 40P01/40001) de façon bornée, propage toute autre erreur", async () => {
    const prismaErr = (code: string, sqlstate?: string) => Object.assign(new Error("deadlock"), { name: "PrismaClientKnownRequestError", code, ...(sqlstate ? { meta: { code: sqlstate } } : {}) })
    let calls = 0
    assert.equal(await withLockRetry(async () => { calls++; if (calls === 1) throw prismaErr("P2034"); return "ok" }), "ok"); assert.equal(calls, 2)
    calls = 0
    assert.equal(await withLockRetry(async () => { calls++; if (calls === 1) throw prismaErr("P2010", "40P01"); return "ok" }), "ok", "requête brute : 40P01 remonté en P2010"); assert.equal(calls, 2)
    calls = 0
    await assert.rejects(withLockRetry(async () => { calls++; throw prismaErr("P2010", "40P01") }), /deadlock/); assert.equal(calls, 3, "borné à 3 tentatives")
    calls = 0
    await assert.rejects(withLockRetry(async () => { calls++; throw prismaErr("P2002") }), /deadlock/); assert.equal(calls, 1, "autre erreur : aucun rejeu")
    void INVOICE_C2_ERRORS
  })
})
