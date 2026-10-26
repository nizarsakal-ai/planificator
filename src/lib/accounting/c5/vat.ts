// TVA (SPEC-BILLING-C5 §3.3) : collectée sur les DÉBITS (pièces émises par date d'émission, avoirs en négatif) ou sur les
// ENCAISSEMENTS (mouvements de trésorerie de la période), déductible sur les factures fournisseurs validées. Tout en centimes ;
// société du contexte uniquement.
//
// Correctif P1-02 (revue Codex du 26/10/2026) — contrat « TVA sur les encaissements » (CGI art. 269-2-c : exigibilité à
// l'encaissement ; art. 272-1 : la taxe perçue n'est imputée/restituée qu'en cas d'annulation/résiliation/impayé définitif
// justifiée par la rectification de la facture) :
// - l'ÉVÉNEMENT d'exigibilité est le mouvement de trésorerie (paiement ; contre-passation = mouvement inverse) ; un avoir n'est
//   PAS un encaissement : il réduit le reste dû et n'entre dans la base des encaissements que par l'absence de paiement futur ;
// - la TVA d'un mouvement est répartie par taux au prorata de la facture, par ALLOCATION CUMULATIVE sur l'historique des
//   mouvements de la facture : part(k) = arrondi(cumul_k × TVA_taux / TTC) − arrondi(cumul_{k−1} × TVA_taux / TTC). La somme des parts
//   au terme du règlement vaut exactement la TVA de la facture par taux (aucune dérive d'arrondi, quel que soit le fractionnement),
//   une contre-passation produit la part négative exacte du paiement annulé (régularisation reliée à un événement et à une base antérieure) ;
// - le calcul est déterministe (ordre : date de paiement, création, identifiant) ; une déclaration enregistrée reste figée ; un mouvement
//   enregistré plus tard (contre-passation) apparaît dans la période de sa date, jamais rétroactivement dans une déclaration passée ;
// - NON COUVERT (refus explicite, voir DECISIONS) : remboursement d'un encaissement après avoir total (aucun mouvement de remboursement
//   n'existe) ⇒ signalé dans `warnings`, aucune régularisation inventée.
import type { Prisma, PrismaClient } from "@prisma/client"
import { assertStoredTotalsMatch, recomputeDocumentTotals } from "@/lib/billing/document-integrity"
import { roundHalfUp, type DocumentTotals } from "@/lib/billing/money"

type Db = PrismaClient | Prisma.TransactionClient
export interface VatRateRow { vatRateBp: number; baseCents: bigint; vatCents: bigint }
export interface VatComputation {
  basis: "DEBITS" | "ENCAISSEMENTS"; periodStart: Date; periodEnd: Date
  collected: VatRateRow[]; collectedCents: bigint; deductibleCents: bigint; dueCents: bigint
  documents: number; payments: number; supplierInvoices: number
  /** Situations hors contrat, signalées explicitement (jamais corrigées silencieusement). */
  warnings: string[]
}

function addRow(map: Map<number, VatRateRow>, bp: number, base: bigint, vat: bigint) {
  const r = map.get(bp) ?? { vatRateBp: bp, baseCents: BigInt(0), vatCents: BigInt(0) }
  r.baseCents += base; r.vatCents += vat; map.set(bp, r)
}

const docSelect = { id: true, number: true, kind: true, status: true, globalDiscountBp: true, vatReverseCharge: true, totalHT: true, totalVAT: true, totalTTC: true, lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true, deductsDepositId: true } } } satisfies Prisma.InvoiceSelect
type DocRow = Prisma.InvoiceGetPayload<{ select: typeof docSelect }>

/** Totaux d'une pièce émise, contrôlés contre les totaux persistés (P1-01 : divergence ⇒ refus explicite). */
function checkedTotals(d: DocRow): DocumentTotals {
  return assertStoredTotalsMatch(d, recomputeDocumentTotals(d))
}

/**
 * Allocation cumulative de la TVA (et de la base) d'une facture sur ses mouvements de trésorerie ordonnés.
 * Renvoie, pour chaque mouvement, sa part par taux ; Σ parts = TVA de la facture quand Σ mouvements = TTC.
 */
export function allocateReceiptsVat(totals: DocumentTotals, movements: readonly { amountCents: bigint }[]): { vatRateBp: number; baseCents: bigint; vatCents: bigint }[][] {
  const ttc = totals.totalTTCCents
  const out: { vatRateBp: number; baseCents: bigint; vatCents: bigint }[][] = []
  if (ttc <= BigInt(0)) return movements.map(() => [])
  let cum = BigInt(0)
  const prev = new Map<number, { base: bigint; vat: bigint }>()
  for (const m of movements) {
    cum += m.amountCents
    const parts: { vatRateBp: number; baseCents: bigint; vatCents: bigint }[] = []
    for (const v of totals.vatSummary) {
      const p = prev.get(v.vatRateBp) ?? { base: BigInt(0), vat: BigInt(0) }
      const base = roundHalfUp(cum * v.baseCents, ttc), vat = roundHalfUp(cum * v.vatCents, ttc)
      parts.push({ vatRateBp: v.vatRateBp, baseCents: base - p.base, vatCents: vat - p.vat })
      prev.set(v.vatRateBp, { base, vat })
    }
    out.push(parts)
  }
  return out
}

export async function computeVat(db: Db, ctx: { companyId: string }, periodStart: Date, periodEnd: Date, basis: "DEBITS" | "ENCAISSEMENTS"): Promise<VatComputation> {
  const companyId = ctx.companyId
  const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate(), 23, 59, 59, 999))
  const map = new Map<number, VatRateRow>()
  const warnings: string[] = []
  let documents = 0, payments = 0
  if (basis === "DEBITS") {
    const docs = await db.invoice.findMany({ where: { companyId, status: { in: ["SENT", "PARTIAL", "PAID", "CANCELLED"] }, sentAt: { not: null }, issueDate: { gte: periodStart, lte: end } }, select: docSelect })
    for (const d of docs) {
      documents++
      const totals = checkedTotals(d)
      const sign = d.kind === "CREDIT_NOTE" ? BigInt(-1) : BigInt(1)
      for (const v of totals.vatSummary) addRow(map, v.vatRateBp, sign * v.baseCents, sign * v.vatCents)
    }
  } else {
    // Factures ayant au moins un mouvement de trésorerie dans la période ; l'allocation cumulative exige TOUS leurs mouvements.
    const inPeriod = await db.invoicePayment.findMany({ where: { companyId, paidAt: { gte: periodStart, lte: end } }, select: { invoiceId: true }, distinct: ["invoiceId"] })
    const ids = inPeriod.map((p) => p.invoiceId)
    const invoices = ids.length === 0 ? [] : await db.invoice.findMany({
      where: { companyId, id: { in: ids } },
      select: { ...docSelect, payments: { orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { id: true, amountCents: true, paidAt: true } } },
      orderBy: { number: "asc" },
    })
    for (const inv of invoices) {
      const totals = checkedTotals(inv)
      const parts = allocateReceiptsVat(totals, inv.payments)
      inv.payments.forEach((p, i) => {
        if (p.paidAt < periodStart || p.paidAt > end) return
        payments++
        for (const part of parts[i]) addRow(map, part.vatRateBp, part.baseCents, part.vatCents)
      })
      documents++
    }
    // Hors contrat : avoir total sur une facture qui a reçu des encaissements (remboursement non pris en charge).
    const refundPending = await db.invoice.findMany({ where: { companyId, kind: "CREDIT_NOTE", creditScope: "TOTAL", status: { in: ["SENT", "PAID"] }, issueDate: { gte: periodStart, lte: end }, creditedInvoice: { payments: { some: {} } } }, select: { number: true, creditedInvoice: { select: { number: true } } } })
    for (const n of refundPending) warnings.push(`Avoir total ${n.number} sur la facture ${n.creditedInvoice?.number ?? "?"} déjà encaissée : la régularisation de la TVA encaissée n'intervient qu'au remboursement effectif (mouvement de trésorerie non pris en charge par le module) — à traiter avec l'expert-comptable.`)
  }
  const supplier = await db.supplierInvoice.findMany({ where: { companyId, status: "VALIDATED", date: { gte: periodStart, lte: end } }, select: { vatCents: true } })
  const deductible = supplier.reduce((s, r) => s + r.vatCents, BigInt(0))
  const collected = [...map.values()].sort((a, b) => a.vatRateBp - b.vatRateBp)
  const collectedCents = collected.reduce((s, r) => s + r.vatCents, BigInt(0))
  return { basis, periodStart, periodEnd, collected, collectedCents, deductibleCents: deductible, dueCents: collectedCents - deductible, documents, payments, supplierInvoices: supplier.length, warnings }
}

