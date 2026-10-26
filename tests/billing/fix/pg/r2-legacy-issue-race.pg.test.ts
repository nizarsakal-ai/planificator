// R2 (revue Codex R2, 26/10/2026) — émission par le chemin Lot B (drapeaux OFF) : le parent est verrouillé AVANT la lecture qui
// nourrit le recalcul. Reproduction Codex : brouillon FAC 100/120 ; la session 2 verrouille la facture et porte lignes et totaux à
// 200/240 sans committer ; l'émission attend ; après commit, la pièce émise porte 240 € stockés = 240 € recalculés (jamais 120/240).
// Ordres : modification→émission et émission→modification, via le cœur réel ET la Server Action réelle (session simulée).
// Deux connexions PostgreSQL indépendantes et barrières explicites.
import assert from "node:assert/strict"
import { after, before, describe, it, mock } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice } from "@/lib/billing/invoices/invoice.service"
import { LIFECYCLE_ERRORS, transitionInvoiceCore } from "@/lib/billing/invoice-lifecycle.core"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { assertStoredTotalsMatch, recomputeDocumentTotals } from "@/lib/billing/document-integrity"
import { A, NOW, holdTransaction, js, seedCompanies, waitFor, waitingSessions, useTestClock } from "./helpers"

const db = new PrismaClient(), db2 = new PrismaClient()
delete process.env.BILLING_COMPLETE_ENABLED; delete process.env.ACCOUNTING_MODULE_ENABLED
mock.module("@/lib/prisma", { namedExports: { prisma: db } })
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } })
mock.module("@/auth", { namedExports: { auth: async () => ({ user: { id: "admA", companyId: "coA", role: "ADMIN" } }) } }) // session simulée (chemin Lot B : invoice.actions lit la session via auth())

let seq = 0
async function legacyDraft(): Promise<string> {
  // Brouillon hérité Lot B : numéro FAC légal déjà attribué (créé avec le drapeau ON pour le confort, puis renuméroté comme une pièce héritée).
  process.env.BILLING_COMPLETE_ENABLED = "true"
  const p = parseInvoiceForm({ worksiteId: "wA", lines: [{ designation: "legacy", quantity: "1", unitPrice: "100", vatRate: "20" }] }); if (!p.ok) throw new Error(p.error)
  const d = await createDraftInvoice(db, A, p.value, NOW); if (!d.ok) throw new Error(d.error)
  delete process.env.BILLING_COMPLETE_ENABLED
  await db.invoice.update({ where: { id: d.value.id }, data: { number: `FAC-2026-R2-${++seq}` } })
  return d.value.id
}
const stored = async (id: string) => { const inv = await db.invoice.findUniqueOrThrow({ where: { id }, include: { lines: true } }); return { status: inv.status, ttc: inv.totalTTC.toString(), recomputed: recomputeDocumentTotals(inv).totalTTCCents, ok: (() => { try { assertStoredTotalsMatch(inv); return true } catch { return false } })() } }
/** Session 2 : édite le brouillon (200 HT / 240 TTC) sous verrou et garde la transaction ouverte. */
async function editHeld(id: string) {
  const h = await holdTransaction(db2)
  await h.tx.$queryRawUnsafe(`SELECT 1 FROM invoices WHERE id = '${id}' FOR UPDATE`)
  await h.tx.invoice.update({ where: { id }, data: { totalHT: "200", totalVAT: "40", totalTTC: "240" } })
  await h.tx.invoiceLine.updateMany({ where: { invoiceId: id }, data: { unitPrice: "200", lineHT: "200" } })
  return h
}

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect(); await db2.$disconnect() })

describe("R2 — émission Lot B sous modification concurrente (cœur réel)", () => {
  it("modification (non committée) → émission : l'émission attend le verrou, puis lit la version finale : 240 € stockés = 240 € recalculés, SENT", async () => {
    const id = await legacyDraft()
    const h = await editHeld(id)
    let settled = false
    const issuing = db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: id, actorId: "admA", to: "SENT", now: NOW }); if (r.ok) await flushDeferredConstraints(tx); return r }).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "l'émission attend le verrou de l'éditeur (lecture APRÈS verrou)"); assert.equal(settled, false)
    await h.commit()
    assert.deepEqual(await issuing, { ok: true, value: undefined })
    assert.deepEqual(await stored(id), { status: "SENT", ttc: "240", recomputed: BigInt(24000), ok: true })
  })
  it("émission (non committée) → modification : la modification attend puis est refusée (plus un brouillon) ; la pièce émise reste 120 = 120", async () => {
    const id = await legacyDraft()
    const h = await holdTransaction(db2)
    const r = await transitionInvoiceCore(h.tx, { companyId: "coA", invoiceId: id, actorId: "admA", to: "SENT", now: NOW }); assert.ok(r.ok, js(r))
    let settled = false
    const editing = db.$transaction(async (tx) => {
      const u = await tx.invoice.updateMany({ where: { id, companyId: "coA", status: "DRAFT" }, data: { totalHT: "200", totalVAT: "40", totalTTC: "240" } })
      if (u.count !== 1) return { ok: false as const, error: LIFECYCLE_ERRORS.notDraft }
      await tx.invoiceLine.updateMany({ where: { invoiceId: id }, data: { unitPrice: "200", lineHT: "200" } }); return { ok: true as const }
    }).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); assert.equal(settled, false)
    await h.commit()
    assert.deepEqual(await editing, { ok: false, error: LIFECYCLE_ERRORS.notDraft })
    assert.deepEqual(await stored(id), { status: "SENT", ttc: "120", recomputed: BigInt(12000), ok: true })
  })
})

describe("R2 — chemin réel : Server Action updateInvoiceStatus (drapeaux OFF, session simulée)", () => {
  it("l'action d'émission attend l'éditeur concurrent puis émet la version finale (240 = 240) ; aucune pièce émise incohérente", async () => {
    const { updateInvoiceStatus, setInvoiceLines } = await import("@/lib/actions/invoice.actions")
    const id = await legacyDraft()
    const h = await editHeld(id)
    let settled = false
    const action = updateInvoiceStatus(id, "SENT").then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); assert.equal(settled, false)
    await h.commit()
    assert.deepEqual(await action, { success: true })
    assert.deepEqual(await stored(id), { status: "SENT", ttc: "240", recomputed: BigInt(24000), ok: true })
    // Après émission, le remplacement des lignes par l'action Lot B est refusé (pièce figée).
    const r = await setInvoiceLines(id, [{ designation: "x", unit: "u", quantity: 1, unitPrice: 300, vatRate: 20 }])
    assert.equal((r as { error?: string }).error, LIFECYCLE_ERRORS.notDraft)
    assert.deepEqual(await stored(id), { status: "SENT", ttc: "240", recomputed: BigInt(24000), ok: true })
  })
})
