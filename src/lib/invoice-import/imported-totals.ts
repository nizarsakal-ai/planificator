// SPEC-INVOICE-IMPORT-001 §5 (amendement du 19/11/2026) — totaux des pièces importées : calcul PUR, sans base ni horloge.
// Les montants sont stockés en valeur absolue (contrainte SQL `totalTTCCents > 0`) : le signe vient TOUJOURS de la nature,
// jamais du montant. Une facture compte en +, un avoir en −.
//   PAID                → encaissé (avoir payé = remboursé ou imputé : vient en déduction de l'encaissé)
//   ISSUED | OVERDUE    → dû (avoir non soldé : vient en déduction du dû) ; facture OVERDUE ou échéance dépassée → en retard
//   PARTIALLY_PAID      → hors totaux (aucun montant réglé connu : rien n'est inventé)
//   UNKNOWN | CANCELLED → hors totaux
// Les totaux ne sont jamais ramenés à zéro : un dû négatif (avoir non soldé sur une facture déjà payée) reste visible.
import type { ImportStatus } from "./types"

export interface ImportedTotalsRow {
  kind: "INVOICE" | "CREDIT_NOTE"
  status: ImportStatus
  totalTTCCents: bigint
  dueDate: Date | null
}

export interface ImportedTotals {
  collectedCents: bigint
  dueCents: bigint
  overdueCents: bigint
  /** Factures (hors avoirs) en attente de règlement. */
  openCount: number
  /** Factures (hors avoirs) en retard. */
  overdueCount: number
  /** Pièces prises en compte dans au moins un total. */
  countedCount: number
  /** Pièces hors totaux, par motif (affichées pour ne rien masquer). */
  excluded: { unknown: number; partial: number; cancelled: number }
}

export class ImportedTotalsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImportedTotalsError"
  }
}

const ZERO = BigInt(0)

/** Montant signé d'une pièce importée : + facture, − avoir. Un montant négatif en entrée est une donnée corrompue. */
export function signedTTCCents(row: Pick<ImportedTotalsRow, "kind" | "totalTTCCents">): bigint {
  if (row.totalTTCCents < ZERO) throw new ImportedTotalsError("Montant TTC importé négatif : le signe doit venir de la nature (facture / avoir).")
  return row.kind === "CREDIT_NOTE" ? -row.totalTTCCents : row.totalTTCCents
}

/** Facture importée en retard : statut source « en retard », ou émise non soldée avec une échéance antérieure à `today`. */
export function isImportedOverdue(row: Pick<ImportedTotalsRow, "kind" | "status" | "dueDate">, today: Date): boolean {
  if (row.kind !== "INVOICE") return false
  if (row.status === "OVERDUE") return true
  return row.status === "ISSUED" && row.dueDate !== null && row.dueDate.getTime() < today.getTime()
}

export function computeImportedTotals(rows: readonly ImportedTotalsRow[], today: Date): ImportedTotals {
  if (Number.isNaN(today.getTime())) throw new ImportedTotalsError("Date du jour invalide.")
  const t: ImportedTotals = { collectedCents: ZERO, dueCents: ZERO, overdueCents: ZERO, openCount: 0, overdueCount: 0, countedCount: 0, excluded: { unknown: 0, partial: 0, cancelled: 0 } }
  for (const row of rows) {
    const signed = signedTTCCents(row)
    switch (row.status) {
      case "PAID":
        t.collectedCents += signed
        t.countedCount++
        break
      case "ISSUED":
      case "OVERDUE":
        t.dueCents += signed
        t.countedCount++
        if (row.kind === "INVOICE") t.openCount++
        if (isImportedOverdue(row, today)) { t.overdueCents += signed; t.overdueCount++ }
        break
      case "PARTIALLY_PAID":
        t.excluded.partial++
        break
      case "CANCELLED":
        t.excluded.cancelled++
        break
      case "UNKNOWN":
        t.excluded.unknown++
        break
      default: {
        const never: never = row.status
        throw new ImportedTotalsError(`Statut importé inconnu : ${String(never)}`)
      }
    }
  }
  return t
}

/** Totaux de la facturation Planificator (forme renvoyée par `invoiceSummary`). */
export interface NativeTotals { collectedCents: bigint; dueCents: bigint; overdueCents: bigint; openCount: number; overdueCount: number }

/** Vue des cartes /factures : total global + détail par source (les sources ne sont jamais fusionnées sans trace). */
export interface CombinedTotals {
  total: NativeTotals
  planificator: NativeTotals
  imported: ImportedTotals | null
}

export function combineTotals(native: NativeTotals, imported: ImportedTotals | null): CombinedTotals {
  if (!imported) return { total: { ...native }, planificator: native, imported: null }
  return {
    total: {
      collectedCents: native.collectedCents + imported.collectedCents,
      dueCents: native.dueCents + imported.dueCents,
      overdueCents: native.overdueCents + imported.overdueCents,
      openCount: native.openCount + imported.openCount,
      overdueCount: native.overdueCount + imported.overdueCount,
    },
    planificator: native,
    imported,
  }
}
