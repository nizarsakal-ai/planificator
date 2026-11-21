/**
 * Lot C Planificator V2 : budgets et marges chantier — règles PURES (sans base, testables au centime).
 *
 * Quatre colonnes par nature de coût :
 * - PRÉVU : la version courante du budget (montant par nature, recette prévue) ;
 * - ENGAGÉ : ce qui est commandé ou contracté mais pas encore consommé (reste à recevoir des commandes d'achat
 *   passées, locations en cours sur leur période prévue, factures fournisseurs imputées encore en attente) ;
 * - RÉEL : ce qui est consommé (sorties de stock vers le chantier valorisées, achats directs reçus sans article,
 *   locations clôturées, matériel propre rendu, frais de véhicules validés imputés à un trajet du chantier, factures
 *   fournisseurs validées imputées au chantier) ;
 * - FACTURÉ : factures et acomptes émis, moins les avoirs émis (montants HT).
 *
 * Règles contre le double comptage (chaque euro compté au plus une fois) :
 * - une réception d'un article entre EN STOCK : elle n'est comptée au chantier qu'à la SORTIE de stock vers ce chantier
 *   (la réception est seulement affichée, comme CUMUL HISTORIQUE des réceptions d'articles des commandes du chantier :
 *   les sorties n'en sont jamais déduites, ce n'est pas un solde de stock ; voir `receivedArticlesCumulativeCents`) ;
 * - une ligne de commande SANS article (prestation, achat direct) ne passe pas par le stock : sa quantité reçue est un
 *   coût réel, son reste à recevoir un engagement ; TOUTE ligne de commande d'achat est rangée en « Matériaux et
 *   fournitures » (le lot A ne porte pas de nature sur la ligne) : une sous-traitance se suit par l'imputation de sa
 *   facture fournisseur, sans commande d'achat ;
 * - le lot A n'a pas de type « retour de chantier » : une entrée manuelle portant le chantier n'est PAS déduite (signalée) ;
 * - une facture fournisseur liée à une réception ou à un contrat de location est déjà comptée par ceux-ci : son
 *   imputation éventuelle est EXCLUE et signalée ;
 * - la main-d'œuvre n'est pas calculée (aucun coût salarial fiable avant la paie, lot H) : budget seulement.
 */

import { committedRentalCents } from "@/lib/equipment/equipment.core"

export type WorksiteCostNature = "MATERIALS" | "SUBCONTRACTING" | "EQUIPMENT" | "VEHICLES" | "LABOR" | "OTHER"
export const COST_NATURES: readonly WorksiteCostNature[] = ["MATERIALS", "SUBCONTRACTING", "EQUIPMENT", "VEHICLES", "LABOR", "OTHER"]
export const COST_NATURE_LABEL: Record<WorksiteCostNature, string> = {
  MATERIALS: "Matériaux et fournitures",
  SUBCONTRACTING: "Sous-traitance",
  EQUIPMENT: "Matériel et location",
  VEHICLES: "Véhicules",
  LABOR: "Main-d'œuvre",
  OTHER: "Autres frais",
}
/** Natures admises pour l'imputation d'une facture fournisseur (la main-d'œuvre n'est pas une facture fournisseur). */
export const ALLOCATION_NATURES: readonly WorksiteCostNature[] = ["MATERIALS", "SUBCONTRACTING", "EQUIPMENT", "VEHICLES", "OTHER"]
export const isCostNature = (v: string): v is WorksiteCostNature => (COST_NATURES as readonly string[]).includes(v)

/** Borne haute de tout montant (10^13 centimes = 100 milliards d'euros), identique aux CHECK de la base. */
export const MAX_CENTS = BigInt(10_000_000_000_000)
export const REASON_MIN = 3
export const REASON_MAX = 500
export const LABEL_MAX = 200

export const BUDGET_ERRORS = {
  notFound: "Élément introuvable.",
  amount: "Montant invalide (positif, au plus 100 milliards d'euros).",
  reason: `Motif de révision obligatoire (${REASON_MIN} à ${REASON_MAX} caractères).`,
  alreadyExists: "Ce chantier a déjà un budget : créez une révision.",
  staleRevision: "Le budget a été révisé entre-temps : rechargez la page avant de réviser.",
  archived: "Chantier archivé : budget en lecture seule.",
  allocationNature: "Nature d'imputation invalide.",
  allocationLinked: "Cette facture fournisseur est déjà rattachée à une réception ou à une location : son coût est déjà compté.",
  allocationRejected: "Facture fournisseur refusée : imputation impossible.",
  allocationExceeds: "Le total imputé dépasserait le montant HT de la facture.",
  allocationCancelled: "Imputation déjà annulée.",
  unchanged: "Révision identique à la version courante : rien à enregistrer.",
  invalidForm: "Formulaire invalide : rechargez la page.",
  label: `Précision trop longue (${LABEL_MAX} caractères au plus).`,
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })

export const validCents = (v: bigint) => typeof v === "bigint" && v >= BigInt(0) && v <= MAX_CENTS

export interface BudgetLineInput { nature: WorksiteCostNature; amountCents: bigint; label?: string | null }
export interface BudgetVersion { plannedRevenueCents: bigint; lines: { nature: WorksiteCostNature; amountCents: bigint; label: string | null }[]; totalCostCents: bigint }

/**
 * Valide une version de budget : recette prévue et montants par nature. Une nature n'apparaît qu'une fois ; les
 * montants nuls ne créent pas de ligne ; une précision trop longue est refusée (jamais tronquée en silence). Le total est la somme exacte des lignes (contrôlée aussi par la base).
 */
export function planBudgetVersion(input: { plannedRevenueCents: bigint; lines: readonly BudgetLineInput[] }): Plan<BudgetVersion> {
  if (!validCents(input.plannedRevenueCents)) return ko(BUDGET_ERRORS.amount)
  const seen = new Set<WorksiteCostNature>()
  const lines: BudgetVersion["lines"] = []
  let total = BigInt(0)
  for (const l of input.lines) {
    if (!isCostNature(l.nature) || seen.has(l.nature)) return ko(BUDGET_ERRORS.amount)
    seen.add(l.nature)
    if (!validCents(l.amountCents)) return ko(BUDGET_ERRORS.amount)
    const trimmed = (l.label ?? "").trim()
    if (trimmed.length > LABEL_MAX) return ko(BUDGET_ERRORS.label)
    const label = trimmed || null
    if (l.amountCents === BigInt(0)) continue
    lines.push({ nature: l.nature, amountCents: l.amountCents, label })
    total += l.amountCents
  }
  if (total > MAX_CENTS) return ko(BUDGET_ERRORS.amount)
  lines.sort((a, b) => COST_NATURES.indexOf(a.nature) - COST_NATURES.indexOf(b.nature))
  return { ok: true, value: { plannedRevenueCents: input.plannedRevenueCents, lines, totalCostCents: total } }
}

export function validateReason(raw: string | null | undefined): Plan<string> {
  const r = (raw ?? "").trim()
  if (r.length < REASON_MIN || r.length > REASON_MAX) return ko(BUDGET_ERRORS.reason)
  return { ok: true, value: r }
}

/** Deux versions identiques (recette, montants et libellés) : une révision sans changement est refusée. */
export function sameVersion(a: BudgetVersion, b: BudgetVersion): boolean {
  if (a.plannedRevenueCents !== b.plannedRevenueCents || a.lines.length !== b.lines.length) return false
  return a.lines.every((l, i) => l.nature === b.lines[i].nature && l.amountCents === b.lines[i].amountCents && l.label === b.lines[i].label)
}

// ── Valorisation ────────────────────────────────────────────────────────────────────────────────────────────────

/** Quantité en millièmes × prix unitaire en centimes, arrondi au centime le plus proche (moitié vers le haut). */
export function valueMilliCents(quantityMilli: number, unitPriceCents: number): bigint {
  if (!Number.isSafeInteger(quantityMilli) || !Number.isSafeInteger(unitPriceCents) || quantityMilli < 0 || unitPriceCents < 0) throw new RangeError("valorisation invalide")
  return (BigInt(quantityMilli) * BigInt(unitPriceCents) + BigInt(500)) / BigInt(1000)
}

export interface PricePoint { articleId: string; at: Date; id: string; unitPriceCents: number }

/**
 * Dernier prix d'achat CONNU à la date de la sortie : le prix de commande de la réception la plus récente de l'article
 * (toutes réceptions de l'entreprise) antérieure ou égale à la sortie ; à égalité de date, l'identifiant départage.
 * Une réception postérieure ne revalorise jamais une sortie passée. Aucun prix ⇒ null (sortie non valorisée, signalée).
 */
export function priceAt(points: readonly PricePoint[], articleId: string, at: Date): number | null {
  let best: PricePoint | null = null
  for (const p of points) {
    if (p.articleId !== articleId || p.at.getTime() > at.getTime()) continue
    if (!best || p.at.getTime() > best.at.getTime() || (p.at.getTime() === best.at.getTime() && p.id > best.id)) best = p
  }
  return best ? best.unitPriceCents : null
}

const DAY_MS = 86_400_000
// Location en cours : `committedRentalCents` du lot B (jours prévus bornes incluses × tarif + frais), source unique.
/** Matériel propre : jours entamés entre sortie et retour (au moins 1) × coût interne journalier (même règle que le lot B). */
export function ownedEquipmentCents(checkedOutAt: Date, returnedAt: Date, dailyCostCents: number): bigint {
  const days = Math.max(1, Math.ceil((returnedAt.getTime() - checkedOutAt.getTime()) / DAY_MS))
  return BigInt(days) * BigInt(dailyCostCents)
}

/** Rapport en points de base (1 % = 100), arrondi au plus proche (moitié en s'éloignant de zéro) ; null si base nulle. */
export function ratioBp(numerator: bigint, denominator: bigint): number | null {
  if (denominator === BigInt(0)) return null
  const neg = (numerator < BigInt(0)) !== (denominator < BigInt(0))
  const n = numerator < BigInt(0) ? -numerator : numerator
  const d = denominator < BigInt(0) ? -denominator : denominator
  const q = (n * BigInt(10000) * BigInt(2) + d) / (BigInt(2) * d)
  return Number(neg ? -q : q)
}

// ── Agrégation ──────────────────────────────────────────────────────────────────────────────────────────────────

export type QuoteStatus = "DRAFT" | "SENT" | "ACCEPTED" | "REFUSED" | "EXPIRED" | "CONVERTED"
export type InvoiceKind = "INVOICE" | "CREDIT_NOTE" | "DEPOSIT"
export type OrderStatus = "DRAFT" | "ORDERED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED"
export type RentalStatus = "ACTIVE" | "CLOSED" | "CANCELLED"
export type SupplierInvoiceStatus = "PENDING" | "VALIDATED" | "REJECTED"

/** Faits bruts d'UN chantier (déjà bornés à l'entreprise et au chantier par la requête). */
export interface WorksiteFacts {
  budget: { revision: number; plannedRevenueCents: bigint; lines: readonly { nature: WorksiteCostNature; amountCents: bigint }[] } | null
  quotes: readonly { status: QuoteStatus; totalHTCents: bigint }[]
  invoices: readonly { kind: InvoiceKind; issued: boolean; totalHTCents: bigint }[]
  /** Sorties de stock (type ISSUE) vers le chantier. */
  stockIssues: readonly { articleId: string; quantityMilli: number; at: Date }[]
  /** Mouvements d'autre type portant le chantier (entrée manuelle, transfert, ajustement) : non comptés, signalés. */
  otherLinkedMovements: number
  /** Historique des prix de réception de l'entreprise (pour valoriser les sorties). */
  pricePoints: readonly PricePoint[]
  /** Lignes des commandes d'achat rattachées au chantier. */
  orderLines: readonly { orderStatus: OrderStatus; hasArticle: boolean; quantityMilli: number; receivedMilli: number; unitPriceCents: number }[]
  rentals: readonly { status: RentalStatus; costCents: bigint | null; startDate: Date; endDate: Date; dailyRateCents: number; fixedFeesCents: number }[]
  ownedBookings: readonly { checkedOutAt: Date; returnedAt: Date; dailyCostCents: number }[]
  /**
   * Réservations de matériel PROPRE sorties ou rendues sur le chantier dont la fiche n'a PAS de coût journalier (cas des
   * fiches créées automatiquement à la réception par le catalogue événementiel) : aucun coût n'est inventé, elles sont
   * signalées (coût matériel manquant, marge incomplète).
   */
  ownedBookingsWithoutCost: number
  /** Imputations de frais de véhicules aux trajets du chantier ; `admitted` = frais validé, devise EUR, source conforme. */
  vehicleAllocations: readonly { amountCents: bigint; admitted: boolean }[]
  /** Imputations de factures fournisseurs non annulées ; `linkedElsewhere` = facture liée à une réception ou une location. */
  supplierAllocations: readonly { nature: WorksiteCostNature; amountHTCents: bigint; invoiceStatus: SupplierInvoiceStatus; linkedElsewhere: boolean }[]
}

export type AnomalyCode = "EQUIPMENT_COST_MISSING" | "UNVALUED_ISSUES" | "OTHER_MOVEMENTS" | "VEHICLE_EXCLUDED" | "ALLOCATION_LINKED" | "ALLOCATION_REJECTED" | "LABOR_NOT_COMPUTED"
export interface Anomaly { code: AnomalyCode; count: number; message: string }

export interface NatureRow { nature: WorksiteCostNature; plannedCents: bigint; committedCents: bigint; actualCents: bigint; remainingCents: bigint; consumedBp: number | null }
export interface WorksiteMargin {
  hasBudget: boolean
  budgetRevision: number | null
  natures: NatureRow[]
  plannedRevenueCents: bigint
  plannedCostCents: bigint
  plannedMarginCents: bigint
  plannedMarginBp: number | null
  signedQuotesHTCents: bigint
  invoicedHTCents: bigint
  toInvoiceCents: bigint
  committedCents: bigint
  actualCents: bigint
  /** Marge à date : facturé − réel. */
  currentMarginCents: bigint
  currentMarginBp: number | null
  /** Marge estimée à terminaison : max(recette prévue, devis signés) − max(prévu, réel + engagé) par nature. */
  forecastMarginCents: bigint
  forecastMarginBp: number | null
  /**
   * Cumul HISTORIQUE, valorisé au prix de commande, des quantités d'articles reçues sur les commandes du chantier.
   * Ce n'est PAS un solde de stock : les sorties (comptées au réel) n'en sont pas déduites, et une sortie peut puiser
   * dans d'autres réceptions (autres commandes, autres chantiers). Soustraire les sorties donnerait un faux reste :
   * le stock est suivi par dépôt et par article (lot A), pas par chantier. Information seulement, jamais additionnée.
   */
  receivedArticlesCumulativeCents: bigint
  anomalies: Anomaly[]
}

const zero = (): Record<WorksiteCostNature, bigint> => ({ MATERIALS: BigInt(0), SUBCONTRACTING: BigInt(0), EQUIPMENT: BigInt(0), VEHICLES: BigInt(0), LABOR: BigInt(0), OTHER: BigInt(0) })
const max = (a: bigint, b: bigint) => (a > b ? a : b)

export function computeWorksiteMargin(f: WorksiteFacts): WorksiteMargin {
  const planned = zero(), committed = zero(), actual = zero()
  const anomalies: Anomaly[] = []
  if (f.budget) for (const l of f.budget.lines) planned[l.nature] += l.amountCents

  // Matériaux : sorties de stock valorisées au dernier prix d'achat connu.
  let unvalued = 0
  for (const s of f.stockIssues) {
    const price = priceAt(f.pricePoints, s.articleId, s.at)
    if (price === null) { unvalued++; continue }
    actual.MATERIALS += valueMilliCents(s.quantityMilli, price)
  }
  if (unvalued > 0) anomalies.push({ code: "UNVALUED_ISSUES", count: unvalued, message: `${unvalued} sortie(s) de stock sans prix d'achat connu à leur date : non valorisée(s).` })
  if (f.otherLinkedMovements > 0) anomalies.push({ code: "OTHER_MOVEMENTS", count: f.otherLinkedMovements, message: `${f.otherLinkedMovements} mouvement(s) de stock autre(s) qu'une sortie portent ce chantier (entrée manuelle, retour, transfert, ajustement) : non comptés ni déduits, à vérifier.` })

  // Commandes d'achat du chantier.
  let receivedArticles = BigInt(0)
  for (const l of f.orderLines) {
    if (l.orderStatus === "DRAFT") continue
    const received = valueMilliCents(Math.min(l.receivedMilli, l.quantityMilli), l.unitPriceCents)
    if (l.hasArticle) receivedArticles += received
    else actual.MATERIALS += received
    if (l.orderStatus === "ORDERED" || l.orderStatus === "PARTIALLY_RECEIVED") {
      committed.MATERIALS += valueMilliCents(Math.max(0, l.quantityMilli - l.receivedMilli), l.unitPriceCents)
    }
  }

  // Matériel : locations (clôturées = réel, en cours = engagé) et matériel propre rendu.
  for (const r of f.rentals) {
    if (r.status === "CLOSED") actual.EQUIPMENT += r.costCents ?? BigInt(0)
    else if (r.status === "ACTIVE") committed.EQUIPMENT += committedRentalCents(r)
  }
  for (const b of f.ownedBookings) actual.EQUIPMENT += ownedEquipmentCents(b.checkedOutAt, b.returnedAt, b.dailyCostCents)
  if (f.ownedBookingsWithoutCost > 0) anomalies.push({ code: "EQUIPMENT_COST_MISSING", count: f.ownedBookingsWithoutCost, message: `Marge incomplète : ${f.ownedBookingsWithoutCost} réservation(s) de matériel propre sortie(s) ou rendue(s) sur ce chantier sans coût journalier renseigné sur la fiche Matériel. Coût matériel manquant, non valorisé : coût réel incomplet et marge potentiellement surestimée tant que ce coût n'est pas renseigné.` })

  // Véhicules : seules les imputations admises.
  let excludedVehicles = 0
  for (const v of f.vehicleAllocations) {
    if (v.admitted) actual.VEHICLES += v.amountCents
    else excludedVehicles++
  }
  if (excludedVehicles > 0) anomalies.push({ code: "VEHICLE_EXCLUDED", count: excludedVehicles, message: `${excludedVehicles} imputation(s) de frais de véhicule exclue(s) (frais non validé, autre devise ou source non conforme).` })

  // Factures fournisseurs imputées.
  let linked = 0, rejected = 0
  for (const a of f.supplierAllocations) {
    if (a.linkedElsewhere) { linked++; continue }
    if (a.invoiceStatus === "REJECTED") { rejected++; continue }
    if (a.invoiceStatus === "VALIDATED") actual[a.nature] += a.amountHTCents
    else committed[a.nature] += a.amountHTCents
  }
  if (linked > 0) anomalies.push({ code: "ALLOCATION_LINKED", count: linked, message: `${linked} imputation(s) sur une facture déjà rattachée à une réception ou une location : exclue(s) pour ne pas compter deux fois.` })
  if (rejected > 0) anomalies.push({ code: "ALLOCATION_REJECTED", count: rejected, message: `${rejected} imputation(s) sur une facture fournisseur refusée : exclue(s).` })
  if (planned.LABOR > BigInt(0)) anomalies.push({ code: "LABOR_NOT_COMPUTED", count: 1, message: "Main-d'œuvre : budget seulement, le coût réel n'est pas calculé (aucune donnée de paie)." })

  // Recettes.
  let signed = BigInt(0)
  for (const q of f.quotes) if (q.status === "ACCEPTED" || q.status === "CONVERTED") signed += q.totalHTCents
  let invoiced = BigInt(0)
  for (const i of f.invoices) {
    if (!i.issued) continue
    invoiced += i.kind === "CREDIT_NOTE" ? -i.totalHTCents : i.totalHTCents
  }

  const natures: NatureRow[] = COST_NATURES.map((n) => ({
    nature: n, plannedCents: planned[n], committedCents: committed[n], actualCents: actual[n],
    remainingCents: planned[n] - actual[n] - committed[n],
    consumedBp: ratioBp(actual[n] + committed[n], planned[n]),
  }))
  const sum = (r: Record<WorksiteCostNature, bigint>) => COST_NATURES.reduce((s, n) => s + r[n], BigInt(0))
  const plannedCost = sum(planned), committedTotal = sum(committed), actualTotal = sum(actual)
  const plannedRevenue = f.budget?.plannedRevenueCents ?? BigInt(0)
  const forecastRevenue = max(plannedRevenue, signed)
  const forecastCost = COST_NATURES.reduce((s, n) => s + max(planned[n], actual[n] + committed[n]), BigInt(0))
  const currentMargin = invoiced - actualTotal
  const forecastMargin = forecastRevenue - forecastCost
  return {
    hasBudget: f.budget !== null,
    budgetRevision: f.budget?.revision ?? null,
    natures,
    plannedRevenueCents: plannedRevenue,
    plannedCostCents: plannedCost,
    plannedMarginCents: plannedRevenue - plannedCost,
    plannedMarginBp: ratioBp(plannedRevenue - plannedCost, plannedRevenue),
    signedQuotesHTCents: signed,
    invoicedHTCents: invoiced,
    toInvoiceCents: max(BigInt(0), forecastRevenue - invoiced),
    committedCents: committedTotal,
    actualCents: actualTotal,
    currentMarginCents: currentMargin,
    currentMarginBp: ratioBp(currentMargin, invoiced),
    forecastMarginCents: forecastMargin,
    forecastMarginBp: ratioBp(forecastMargin, forecastRevenue),
    receivedArticlesCumulativeCents: receivedArticles,
    anomalies,
  }
}

/** Imputation de facture fournisseur : nature admise, montant positif, total non annulé ≤ montant HT de la facture. */
export function planAllocation(input: {
  nature: string; amountHTCents: bigint; invoiceTotalHTCents: bigint; alreadyAllocatedCents: bigint
  invoiceStatus: SupplierInvoiceStatus; linkedElsewhere: boolean
}): Plan<{ nature: WorksiteCostNature }> {
  if (!(ALLOCATION_NATURES as readonly string[]).includes(input.nature)) return ko(BUDGET_ERRORS.allocationNature)
  if (input.linkedElsewhere) return ko(BUDGET_ERRORS.allocationLinked)
  if (input.invoiceStatus === "REJECTED") return ko(BUDGET_ERRORS.allocationRejected)
  if (input.amountHTCents <= BigInt(0) || input.amountHTCents > MAX_CENTS) return ko(BUDGET_ERRORS.amount)
  if (input.alreadyAllocatedCents + input.amountHTCents > input.invoiceTotalHTCents) return ko(BUDGET_ERRORS.allocationExceeds)
  return { ok: true, value: { nature: input.nature as WorksiteCostNature } }
}
