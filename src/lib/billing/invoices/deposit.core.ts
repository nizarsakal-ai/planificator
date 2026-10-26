// ═══════════════════════════════════════════════════════════════════════════
// Acomptes — Lot C3 (SPEC-BILLING-C3) : calcul pur des lignes d'acompte par taux de TVA et des lignes de
// déduction sur la facture de solde. Tout en centimes (BigInt), arrondi demi-supérieur.
// ═══════════════════════════════════════════════════════════════════════════
import { MoneyError, roundHalfUp, vatCents, type VatSummaryRow } from "@/lib/billing/money"

export interface DepositLineSpec {
  vatRateBp: number
  /** HT de la ligne d'acompte (base × pourcentage, ou part du montant TTC). */
  netCents: bigint
  vatCents: bigint
}

export type DepositRequest = { kind: "PERCENT"; bp: number } | { kind: "AMOUNT_TTC"; cents: bigint }

/**
 * Ventile un acompte sur les taux de TVA du devis (bases HT après remises).
 * - PERCENT : HT par taux = base × bp / 10000 (arrondi), TVA au taux ⇒ le TTC résulte des arrondis par ligne.
 * - AMOUNT_TTC : part de chaque taux = montant × (TTC du taux / TTC total) ; HT = part / (1 + taux) arrondi ;
 *   la dernière ligne absorbe l'écart pour que Σ TTC = montant demandé exactement.
 */
export function computeDepositLines(summary: readonly VatSummaryRow[], request: DepositRequest, vatReverseCharge: boolean): DepositLineSpec[] {
  const rows = summary.filter((r) => r.baseCents > BigInt(0))
  if (rows.length === 0) throw new MoneyError("DEPOSIT_EMPTY_QUOTE")
  if (request.kind === "PERCENT") {
    if (!Number.isInteger(request.bp) || request.bp <= 0 || request.bp > 10000) throw new MoneyError("PERCENT_INVALID")
    return rows.map((r) => {
      const net = roundHalfUp(r.baseCents * BigInt(request.bp), BigInt(10000))
      return { vatRateBp: r.vatRateBp, netCents: net, vatCents: vatReverseCharge ? BigInt(0) : vatCents(net, r.vatRateBp) }
    })
  }
  if (request.cents <= BigInt(0)) throw new MoneyError("AMOUNT_INVALID")
  const totalTTC = rows.reduce((s, r) => s + r.baseCents + r.vatCents, BigInt(0))
  if (request.cents > totalTTC) throw new MoneyError("DEPOSIT_EXCEEDS_QUOTE")
  const out: DepositLineSpec[] = []
  let allocated = BigInt(0)
  rows.forEach((r, i) => {
    const rowTTC = r.baseCents + r.vatCents
    let shareTTC = i === rows.length - 1 ? request.cents - allocated : roundHalfUp(request.cents * rowTTC, totalTTC)
    if (shareTTC < BigInt(0)) shareTTC = BigInt(0)
    const divisor = BigInt(10000 + (vatReverseCharge ? 0 : r.vatRateBp))
    let net = roundHalfUp(shareTTC * BigInt(10000), divisor)
    let vat = vatReverseCharge ? BigInt(0) : vatCents(net, r.vatRateBp)
    // Ajustement d'un centime pour que net + TVA = part TTC exactement (arrondis composés).
    for (let k = 0; k < 3 && net + vat !== shareTTC; k++) {
      net += shareTTC - (net + vat) > BigInt(0) ? BigInt(1) : BigInt(-1)
      vat = vatReverseCharge ? BigInt(0) : vatCents(net, r.vatRateBp)
    }
    allocated += net + vat
    out.push({ vatRateBp: r.vatRateBp, netCents: net, vatCents: vat })
  })
  return out
}

export function depositTotal(lines: readonly DepositLineSpec[]): { htCents: bigint; vatCents: bigint; ttcCents: bigint } {
  const ht = lines.reduce((s, l) => s + l.netCents, BigInt(0))
  const vat = lines.reduce((s, l) => s + l.vatCents, BigInt(0))
  return { htCents: ht, vatCents: vat, ttcCents: ht + vat }
}

export interface IssuedDeposit { id: string; number: string; issueDate: Date; lines: { vatRateBp: number; netCents: bigint }[] }

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
const pct = (bp: number) => { const u = Math.trunc(bp / 100), d = bp % 100; return d === 0 ? String(u) : `${u},${String(d).padStart(2, "0").replace(/0$/, "")}` }

/** Lignes de déduction (une par acompte et par taux) à ajouter à la facture de solde. */
export function buildDeductionLines(deposits: readonly IssuedDeposit[]): { deductsDepositId: string; designation: string; vatRateBp: number; unitPriceCents: bigint }[] {
  const out: { deductsDepositId: string; designation: string; vatRateBp: number; unitPriceCents: bigint }[] = []
  for (const d of deposits) {
    for (const l of d.lines) {
      if (l.netCents === BigInt(0)) continue
      out.push({ deductsDepositId: d.id, designation: `Déduction acompte ${d.number} du ${dateFr.format(d.issueDate)} (TVA ${pct(l.vatRateBp)} %)`, vatRateBp: l.vatRateBp, unitPriceCents: -l.netCents })
    }
  }
  return out
}

export function depositDesignation(quoteNumber: string, request: DepositRequest, vatRateBp: number): string {
  const what = request.kind === "PERCENT" ? `de ${pct(request.bp)} %` : "(montant convenu)"
  return `Acompte ${what} sur le devis ${quoteNumber} (base TVA ${pct(vatRateBp)} %)`
}
