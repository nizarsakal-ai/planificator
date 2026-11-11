/**
 * Lot A Planificator V2 : règles métier PURES du stock et des achats (sans base, testables isolément).
 * Le service (`stock.service.ts`) les applique avant toute écriture ; la base porte les mêmes invariants en CHECK.
 */
import { lineAmountCents } from "@/lib/stock/quantity"

export type MovementType = "RECEIPT" | "ISSUE" | "TRANSFER" | "ADJUSTMENT"
export type OrderStatus = "DRAFT" | "ORDERED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED"

export const STOCK_ERRORS = {
  invalidMovement: "Mouvement de stock incohérent.",
  sameWarehouse: "Le dépôt de départ et le dépôt d'arrivée doivent être différents.",
  reasonRequired: "Un motif est obligatoire pour un ajustement.",
  insufficient: "Stock insuffisant dans le dépôt de départ.",
  notFound: "Élément introuvable.",
  inactiveWarehouse: "Ce dépôt est désactivé.",
  orderNotEditable: "Seule une commande en brouillon peut être modifiée.",
  orderNotReceivable: "Cette commande ne peut pas être réceptionnée dans son état actuel.",
  overReceipt: "La quantité reçue dépasse la quantité restant à recevoir.",
  emptyReceipt: "Aucune quantité à réceptionner.",
  emptyOrder: "Une commande doit comporter au moins une ligne.",
  conflict: "L'élément a changé entre-temps ; rechargez la page.",
  supplierInvoiceMismatch: "La facture fournisseur ne correspond pas au fournisseur de la commande.",
} as const

export interface MovementInput {
  type: MovementType
  quantityMilli: number
  fromWarehouseId?: string | null
  toWarehouseId?: string | null
  reason?: string | null
}

/** Variation de stock par dépôt qu'implique un mouvement (positive = entrée, négative = sortie). */
export interface StockDelta { warehouseId: string; deltaMilli: number }

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }

/** Valide un mouvement et calcule ses variations. Même règle que la contrainte CHECK `stock_movements_values_check`. */
export function planMovement(m: MovementInput): Plan<StockDelta[]> {
  const q = m.quantityMilli
  if (!Number.isSafeInteger(q) || q <= 0) return { ok: false, error: STOCK_ERRORS.invalidMovement }
  const from = m.fromWarehouseId || null
  const to = m.toWarehouseId || null
  switch (m.type) {
    case "RECEIPT":
      return to && !from ? { ok: true, value: [{ warehouseId: to, deltaMilli: q }] } : { ok: false, error: STOCK_ERRORS.invalidMovement }
    case "ISSUE":
      return from && !to ? { ok: true, value: [{ warehouseId: from, deltaMilli: -q }] } : { ok: false, error: STOCK_ERRORS.invalidMovement }
    case "TRANSFER":
      if (!from || !to) return { ok: false, error: STOCK_ERRORS.invalidMovement }
      if (from === to) return { ok: false, error: STOCK_ERRORS.sameWarehouse }
      return { ok: true, value: [{ warehouseId: from, deltaMilli: -q }, { warehouseId: to, deltaMilli: q }] }
    case "ADJUSTMENT": {
      const reason = (m.reason ?? "").trim()
      if (!reason || reason.length > 500) return { ok: false, error: STOCK_ERRORS.reasonRequired }
      if (Boolean(from) === Boolean(to)) return { ok: false, error: STOCK_ERRORS.invalidMovement }
      return { ok: true, value: [to ? { warehouseId: to, deltaMilli: q } : { warehouseId: from!, deltaMilli: -q }] }
    }
    default:
      return { ok: false, error: STOCK_ERRORS.invalidMovement }
  }
}

/** Inventaire : l'écart entre la quantité comptée et la quantité enregistrée devient un ajustement (ou rien). */
export function planInventoryCount(recordedMilli: number, countedMilli: number, warehouseId: string, reason: string): Plan<MovementInput | null> {
  if (!Number.isSafeInteger(countedMilli) || countedMilli < 0) return { ok: false, error: STOCK_ERRORS.invalidMovement }
  const diff = countedMilli - recordedMilli
  if (diff === 0) return { ok: true, value: null }
  const text = `Inventaire : ${reason.trim() || "comptage"}`.slice(0, 500)
  return {
    ok: true,
    value: diff > 0
      ? { type: "ADJUSTMENT", quantityMilli: diff, toWarehouseId: warehouseId, reason: text }
      : { type: "ADJUSTMENT", quantityMilli: -diff, fromWarehouseId: warehouseId, reason: text },
  }
}

export interface OrderLineState { id: string; quantityMilli: number; receivedMilli: number; unitPriceCents: number }
export interface ReceiptRequestLine { orderLineId: string; quantityMilli: number }

/**
 * Réception d'une commande : chaque quantité doit être positive et ne pas dépasser le reste à recevoir ; les lignes à
 * zéro sont ignorées ; une même ligne ne peut apparaître qu'une fois. Retourne les lignes retenues et le nouvel état.
 */
export function planReceipt(status: OrderStatus, lines: readonly OrderLineState[], request: readonly ReceiptRequestLine[]):
  Plan<{ lines: ReceiptRequestLine[]; nextStatus: OrderStatus }> {
  if (status !== "ORDERED" && status !== "PARTIALLY_RECEIVED") return { ok: false, error: STOCK_ERRORS.orderNotReceivable }
  const byId = new Map(lines.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const kept: ReceiptRequestLine[] = []
  for (const r of request) {
    if (seen.has(r.orderLineId)) return { ok: false, error: STOCK_ERRORS.invalidMovement }
    seen.add(r.orderLineId)
    const line = byId.get(r.orderLineId)
    if (!line) return { ok: false, error: STOCK_ERRORS.notFound }
    if (!Number.isSafeInteger(r.quantityMilli) || r.quantityMilli < 0) return { ok: false, error: STOCK_ERRORS.invalidMovement }
    if (r.quantityMilli === 0) continue
    if (r.quantityMilli > line.quantityMilli - line.receivedMilli) return { ok: false, error: STOCK_ERRORS.overReceipt }
    kept.push(r)
  }
  if (kept.length === 0) return { ok: false, error: STOCK_ERRORS.emptyReceipt }
  const after = lines.map((l) => l.receivedMilli + (kept.find((k) => k.orderLineId === l.id)?.quantityMilli ?? 0))
  const complete = lines.every((l, i) => after[i] >= l.quantityMilli)
  return { ok: true, value: { lines: kept, nextStatus: complete ? "RECEIVED" : "PARTIALLY_RECEIVED" } }
}

/** Total HT d'une commande (centimes, BigInt). */
export function orderTotalCents(lines: readonly { quantityMilli: number; unitPriceCents: number }[]): bigint {
  return lines.reduce((sum, l) => sum + lineAmountCents(l.quantityMilli, l.unitPriceCents), BigInt("0"))
}

export type MatchStatus = "EN_ATTENTE" | "CONFORME" | "ECART_FACTURE"

/**
 * Rapprochement commande, réception et facture, à la commande et en HT :
 * - commandé : total des lignes ; reçu : valorisé au prix de la commande ; facturé : somme HT des factures liées ;
 * - EN_ATTENTE tant que rien n'est facturé ; CONFORME si le facturé égale le reçu à la tolérance près ;
 * - ECART_FACTURE sinon (facture au-delà ou en deçà du reçu ; une commande soldée a toujours reçu = commandé, la base
 *   interdisant la surréception).
 * La tolérance (centimes) absorbe les arrondis de facture ; elle est fixée par l'appelant, jamais négative.
 */
export function matchOrder(input: { lines: readonly OrderLineState[]; invoicedHTCents: bigint; toleranceCents?: bigint }):
  { orderedCents: bigint; receivedCents: bigint; invoicedCents: bigint; status: MatchStatus } {
  const tol = input.toleranceCents && input.toleranceCents > BigInt("0") ? input.toleranceCents : BigInt("0")
  const orderedCents = orderTotalCents(input.lines)
  const receivedCents = input.lines.reduce((s, l) => s + lineAmountCents(l.receivedMilli, l.unitPriceCents), BigInt("0"))
  const invoicedCents = input.invoicedHTCents
  const abs = (v: bigint) => (v < BigInt("0") ? -v : v)
  const status: MatchStatus = invoicedCents === BigInt("0") ? "EN_ATTENTE" : abs(invoicedCents - receivedCents) <= tol ? "CONFORME" : "ECART_FACTURE"
  return { orderedCents, receivedCents, invoicedCents, status }
}

/** Seuil d'alerte : vrai si un minimum est défini et que la quantité est en dessous. */
export function belowThreshold(quantityMilli: number, minQuantityMilli: number | null | undefined): boolean {
  return typeof minQuantityMilli === "number" && quantityMilli < minQuantityMilli
}
