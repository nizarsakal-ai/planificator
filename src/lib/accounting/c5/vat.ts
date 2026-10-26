// TVA (SPEC-BILLING-C5 §3.3) : collectée sur les DÉBITS (pièces émises par date d'émission, avoirs en négatif) ou sur les
// ENCAISSEMENTS (mouvements de trésorerie de la période), déductible sur les factures fournisseurs validées. Tout en centimes ;
// société du contexte uniquement.
//
// Correctif P1-02 (revue Codex du 26/10/2026) — contrat « TVA sur les encaissements » (CGI art. 269-2-c : exigibilité à
// l'encaissement ; art. 272-1 : la taxe perçue n'est imputée/restituée qu'en cas d'annulation/résiliation/impayé définitif
// justifiée par la rectification de la facture) :
// - l'ÉVÉNEMENT d'exigibilité est le mouvement de trésorerie (paiement ; contre-passation = mouvement inverse) ; un avoir n'est
//   PAS un encaissement : il réduit le reste dû et n'entre pas dans la base des encaissements ;
// - correctif R1 (revue Codex R2 du 26/10/2026) : l'assiette d'allocation est la facture NETTE de ses avoirs partiels émis
//   (base et TVA par taux, avoir par avoir) — un avoir ciblé sur un poste annule ce poste (et sa TVA) de l'assiette. Les
//   événements d'une facture (paiements, contre-passations, avoirs) sont ordonnés chronologiquement ; la part d'un mouvement k
//   est part(k) = arrondi(min(cumul_k, TTC_net_k) × TVA_taux_net_k / TTC_net_k) − Σ parts déjà attribuées au taux. Un avoir émis
//   APRÈS des encaissements produit une RÉAFFECTATION par taux datée de l'avoir (reliée à l'événement et aux parts antérieures),
//   jamais une réécriture d'une période antérieure ; la somme des parts au terme du règlement vaut exactement la TVA nette par taux.
//   Un avoir partiel ne porte jamais sur une somme encaissée (plafond C4 : avoir ≤ reste à payer) : la réaffectation ne régularise
//   que la ventilation par taux d'un encaissement conservé, pas une restitution ;
// - le calcul est déterministe (ordre : jour, avoir avant paiement le même jour, création, identifiant) ; une déclaration enregistrée
//   reste figée ; un événement enregistré plus tard apparaît dans la période de sa date, jamais rétroactivement ;
// - NON COUVERT (refus explicite, voir DECISIONS) : encaissement conservé au-delà de la facture nette (avoir total après paiement,
//   ou données héritées) ⇒ remboursement non modélisé ⇒ `warnings` ; aucune régularisation inventée ; la déclaration (R5) est REFUSÉE
//   tant qu'un tel cas existe dans la période. Cycle R4 (T2) : la réaffectation après encaissement antérieur et le cas « paiement et avoir
//   ciblé le même jour » (chronologie au jour non prouvée) sont détectés structurellement et refusés conservatoirement ; un écart avec une
//   période déjà déclarée est signalé. Cycle R5 (U1) : le caractère hors contrat porte sur l'HISTORIQUE de la facture — tout mouvement
//   postérieur à un avoir hors contrat (réaffectation / même jour) est lui-même hors contrat, quelle que soit sa période.
import type { Prisma, PrismaClient } from "@prisma/client"
import { assertStoredTotalsMatch, recomputeDocumentTotals } from "@/lib/billing/document-integrity"
import { centsToDecimalString, roundHalfUp, type DocumentTotals } from "@/lib/billing/money"

type Db = PrismaClient | Prisma.TransactionClient
export interface VatRateRow { vatRateBp: number; baseCents: bigint; vatCents: bigint }
export interface VatComputation {
  basis: "DEBITS" | "ENCAISSEMENTS"; periodStart: Date; periodEnd: Date
  collected: VatRateRow[]; collectedCents: bigint; deductibleCents: bigint; dueCents: bigint
  documents: number; payments: number; supplierInvoices: number
  /** R1 : avoirs partiels de la période ayant réaffecté par taux des encaissements antérieurs (régularisations datées de l'avoir). */
  adjustments: number
  /** Situations hors contrat, signalées explicitement (jamais corrigées silencieusement) ; R5 : bloquent l'enregistrement d'une déclaration. */
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

export type VatEvent =
  | { kind: "PAYMENT"; amountCents: bigint }
  | { kind: "CREDIT"; totals: DocumentTotals }
export interface VatEventParts { parts: VatRateRow[]; /** encaissement conservé au-delà de la facture nette (remboursement non modélisé) */ excessCents: bigint }

/**
 * Allocation de la TVA (et de la base) d'une facture sur ses ÉVÉNEMENTS ordonnés (paiements, contre-passations, avoirs).
 * L'assiette est la facture nette des avoirs émis jusqu'à l'événement ; cible par taux = arrondi(min(cumul, TTC net) × montant net du
 * taux / TTC net) ; la part de l'événement = cible − déjà attribué. Un avoir après encaissement réaffecte par taux (parts de l'avoir) ;
 * Σ parts = TVA nette par taux dès que Σ mouvements = TTC net. TTC net ≤ 0 ou cumul > TTC net ⇒ allocation gelée (aucune part), `excessCents` > 0.
 */
export function allocateReceiptsVatEvents(original: DocumentTotals, events: readonly VatEvent[]): VatEventParts[] {
  const net = new Map<number, { base: bigint; vat: bigint }>()
  for (const v of original.vatSummary) net.set(v.vatRateBp, { base: v.baseCents, vat: v.vatCents })
  const allocated = new Map<number, { base: bigint; vat: bigint }>()
  let netTTC = original.totalTTCCents, cum = BigInt(0)
  const out: VatEventParts[] = []
  for (const e of events) {
    if (e.kind === "CREDIT") {
      for (const v of e.totals.vatSummary) {
        const n = net.get(v.vatRateBp) ?? { base: BigInt(0), vat: BigInt(0) }
        net.set(v.vatRateBp, { base: n.base - v.baseCents, vat: n.vat - v.vatCents })
      }
      netTTC -= e.totals.totalTTCCents
    } else cum += e.amountCents
    const parts: VatRateRow[] = []
    const excess = cum > netTTC && cum > BigInt(0) ? cum - (netTTC > BigInt(0) ? netTTC : BigInt(0)) : BigInt(0)
    // Encaissement conservé au-delà de la facture nette (avoir total après paiement, données héritées) : hors contrat ⇒ allocation GELÉE
    // (aucune part, ni positive ni négative : aucune régularisation inventée), l'excès est signalé à l'appelant.
    if (netTTC > BigInt(0) && excess === BigInt(0)) {
      const eff = cum
      for (const [bp, n] of net) {
        const prev = allocated.get(bp) ?? { base: BigInt(0), vat: BigInt(0) }
        const base = roundHalfUp(eff * n.base, netTTC), vat = roundHalfUp(eff * n.vat, netTTC)
        if (base !== prev.base || vat !== prev.vat) parts.push({ vatRateBp: bp, baseCents: base - prev.base, vatCents: vat - prev.vat })
        allocated.set(bp, { base, vat })
      }
    }
    out.push({ parts, excessCents: excess })
  }
  return out
}

/** Compatibilité (tests P1-02) : allocation cumulative sans avoir = cas particulier de l'allocation par événements. */
export function allocateReceiptsVat(totals: DocumentTotals, movements: readonly { amountCents: bigint }[]): { vatRateBp: number; baseCents: bigint; vatCents: bigint }[][] {
  if (totals.totalTTCCents <= BigInt(0)) return movements.map(() => [])
  return allocateReceiptsVatEvents(totals, movements.map((m) => ({ kind: "PAYMENT" as const, amountCents: m.amountCents }))).map((e) => totals.vatSummary.map((v) => e.parts.find((p) => p.vatRateBp === v.vatRateBp) ?? { vatRateBp: v.vatRateBp, baseCents: BigInt(0), vatCents: BigInt(0) }))
}

export async function computeVat(db: Db, ctx: { companyId: string }, periodStart: Date, periodEnd: Date, basis: "DEBITS" | "ENCAISSEMENTS"): Promise<VatComputation> {
  const companyId = ctx.companyId
  const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate(), 23, 59, 59, 999))
  const map = new Map<number, VatRateRow>()
  const warnings: string[] = []
  let documents = 0, payments = 0, adjustments = 0
  if (basis === "DEBITS") {
    const docs = await db.invoice.findMany({ where: { companyId, status: { in: ["SENT", "PARTIAL", "PAID", "CANCELLED"] }, sentAt: { not: null }, issueDate: { gte: periodStart, lte: end } }, select: docSelect })
    for (const d of docs) {
      documents++
      const totals = checkedTotals(d)
      const sign = d.kind === "CREDIT_NOTE" ? BigInt(-1) : BigInt(1)
      for (const v of totals.vatSummary) addRow(map, v.vatRateBp, sign * v.baseCents, sign * v.vatCents)
    }
  } else {
    // Factures ayant un mouvement de trésorerie OU un avoir émis dans la période ; l'allocation par événements exige TOUT leur historique.
    const inPeriod = await db.invoicePayment.findMany({ where: { companyId, paidAt: { gte: periodStart, lte: end } }, select: { invoiceId: true }, distinct: ["invoiceId"] })
    const creditedInPeriod = await db.invoice.findMany({ where: { companyId, kind: "CREDIT_NOTE", status: { in: ["SENT", "PAID"] }, issueDate: { gte: periodStart, lte: end }, creditedInvoiceId: { not: null } }, select: { creditedInvoiceId: true }, distinct: ["creditedInvoiceId"] })
    const ids = [...new Set([...inPeriod.map((p) => p.invoiceId), ...creditedInPeriod.map((c) => c.creditedInvoiceId as string)])]
    // Même famille U1 (cycle R5) : un mouvement saisi APRÈS la déclaration de la période qui le contient (paiement antidaté, import bancaire
    // tardif) n'a jamais été déclaré et ne le sera pas (déclaration figée) ; l'allocation cumulative des mouvements ULTÉRIEURS de la même
    // facture en dépend ⇒ ces mouvements sont hors contrat et leur période est refusée tant que la régularisation n'est pas traitée.
    const declaredEnc = await db.vatDeclaration.findMany({ where: { companyId, basis: "ENCAISSEMENTS", declaredAt: { not: null } }, select: { periodStart: true, periodEnd: true, declaredAt: true } })
    const declaredEndOf = (d: { periodEnd: Date }) => new Date(Date.UTC(d.periodEnd.getUTCFullYear(), d.periodEnd.getUTCMonth(), d.periodEnd.getUTCDate(), 23, 59, 59, 999))
    const invoices = ids.length === 0 ? [] : await db.invoice.findMany({
      where: { companyId, id: { in: ids }, kind: { not: "CREDIT_NOTE" } },
      select: {
        ...docSelect,
        payments: { select: { id: true, amountCents: true, paidAt: true, createdAt: true } },
        creditNotes: { where: { kind: "CREDIT_NOTE", status: { in: ["SENT", "PAID"] } }, select: { ...docSelect, issueDate: true, createdAt: true, sentAt: true } },
      },
      orderBy: { number: "asc" },
    })
    const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    for (const inv of invoices) {
      const totals = checkedTotals(inv)
      // Chronologie déterministe : jour, avoir avant paiement le même jour, création, identifiant.
      type Ev = { at: number; rank: number; createdAt: Date; id: string; date: Date; event: VatEvent; number: string }
      const evs: Ev[] = [
        ...inv.payments.map((p): Ev => ({ at: day(p.paidAt), rank: 1, createdAt: p.createdAt, id: p.id, date: p.paidAt, number: "", event: { kind: "PAYMENT", amountCents: p.amountCents } })),
        ...inv.creditNotes.map((c): Ev => ({ at: day(c.issueDate), rank: 0, createdAt: c.createdAt, id: c.id, date: c.issueDate, number: c.number, event: { kind: "CREDIT", totals: checkedTotals(c) } })),
      ].sort((a, b) => a.at - b.at || a.rank - b.rank || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const allocated = allocateReceiptsVatEvents(totals, evs.map((e) => e.event))
      // T2 (cycle R4) : la catégorie « avoir ciblé après encaissement antérieur, facture multi-taux » est détectée STRUCTURELLEMENT
      // (chronologie des dates métier), indépendamment du résultat de l'allocation et de l'ordre de tri des événements d'un même jour :
      // - encaissement à une date STRICTEMENT antérieure à l'avoir ⇒ réaffectation (hors contrat tant que non validée) ;
      // - paiement et avoir le MÊME jour ⇒ chronologie non prouvée (les dates de paiement sont au jour) ⇒ ambigu ⇒ refus conservatoire ;
      //   l'ordre de tri (avoir avant paiement) reste une convention de calcul, jamais une preuve, et n'est pas inversé silencieusement.
      const multiRate = totals.vatSummary.filter((v) => v.baseCents !== BigInt(0)).length > 1
      // U1 (cycle R5, revue Codex R4) : le caractère hors contrat est établi sur TOUT l'historique de la facture, pas seulement sur les
      // avoirs datés dans la période. Un avoir partiel ciblé sur une facture multi-taux est hors contrat si un encaissement NET
      // (paiements − contre-passations, dates strictement antérieures) existe avant lui (réaffectation non validée) ou si un mouvement
      // de trésorerie est daté du même jour (chronologie non prouvée). À partir de la date du premier avoir hors contrat, la ventilation
      // par taux de TOUT mouvement ultérieur de la facture dépend de cette réaffectation : ces mouvements sont eux-mêmes hors contrat et
      // la période qui les contient est refusée, quelle que soit la période de l'avoir (mars refusé ⇒ avril, mai… refusés aussi).
      // Contrat explicite (DECISIONS R5) : un encaissement antérieur intégralement contre-passé AVANT l'avoir (net = 0) n'est pas un
      // encaissement conservé ⇒ l'avoir est traité comme « avant tout encaissement » (oracle 10 €) ; une contre-passation datée APRÈS
      // l'avoir est un mouvement dépendant (période refusée). Les mouvements strictement antérieurs à l'avoir ne sont pas concernés
      // (leur ventilation n'en dépend pas). Aucune résolution automatique : la levée relève d'une règle validée par l'expert-comptable.
      const credits = evs.filter((e) => e.event.kind === "CREDIT" && e.event.totals.totalTTCCents < totals.totalTTCCents)
      const netPriorOf = (c: Ev) => evs.filter((p) => p.event.kind === "PAYMENT" && p.at < c.at).reduce((s2, p) => s2 + (p.event.kind === "PAYMENT" ? p.event.amountCents : BigInt(0)), BigInt(0))
      const sameDayOf = (c: Ev) => evs.filter((p) => p.event.kind === "PAYMENT" && p.at === c.at && p.event.amountCents !== BigInt(0)).length
      let taint: { credit: Ev; kind: "prior" | "sameDay" } | null = null
      if (multiRate) for (const c of credits) { const k = netPriorOf(c) !== BigInt(0) ? "prior" : sameDayOf(c) > 0 ? "sameDay" : null; if (k && (!taint || c.at < taint.credit.at)) taint = { credit: c, kind: k } }
      const taintInPeriod = !!taint && taint.credit.date >= periodStart && taint.credit.date <= end
      let late: { at: number; date: Date; source: string; period: string } | null = null
      // Les avoirs font partie du même historique cumulatif que les paiements. Leur date métier
      // peut précéder un paiement déjà déclaré alors que leur saisie/émission est postérieure.
      // Dans ce cas le test « avoir après encaissement » ne suffit pas : la période figée manque
      // l'avoir, et la ventilation des événements suivants doit rester bloquée.
      const recordedEvents = [
        ...inv.payments.map(p => ({ date: p.paidAt, recordedAt: p.createdAt, source: "encaissement" })),
        ...inv.creditNotes.map(c => ({ date: c.issueDate, recordedAt: new Date(Math.max(c.createdAt.getTime(), c.sentAt?.getTime() ?? 0)), source: `avoir ${c.number}` })),
      ]
      for (const e of recordedEvents) {
        const d = declaredEnc.find(x => x.declaredAt && e.date >= x.periodStart && e.date <= declaredEndOf(x) && e.recordedAt > x.declaredAt)
        if (d && e.date < periodStart && (!late || day(e.date) < late.at)) late = { at: day(e.date), date: e.date, source: e.source, period: `${d.periodStart.toISOString().slice(0, 10)} → ${d.periodEnd.toISOString().slice(0, 10)}` }
      }
      let inPeriodEvents = 0, excessWarned = false, dependent = 0, dependentLate = 0
      evs.forEach((e, i) => {
        if (e.date < periodStart || e.date > end) return
        inPeriodEvents++
        // Un avoir réalloue lui aussi le cumul : une dépendance à un encaissement non déclaré
        // ne disparaît pas lorsque la période suivante contient seulement un avoir.
        if (late && e.at >= late.at) dependentLate++
        if (e.event.kind === "PAYMENT") {
          payments++
          if (taint && e.at >= taint.credit.at) dependent++
        } else {
          if (allocated[i].parts.length > 0) adjustments++
          if (multiRate && e.event.totals.totalTTCCents < totals.totalTTCCents) {
            const priorPaid = netPriorOf(e), sameDay = sameDayOf(e)
            if (priorPaid !== BigInt(0)) warnings.push(`Avoir ${e.number} sur la facture ${inv.number} après encaissement antérieur (facture multi-taux) : réaffectation de la TVA encaissée par taux à la date de l'avoir — règle en attente de validation par l'expert-comptable ; la déclaration de cette période est refusée jusqu'à validation.`)
            if (sameDay > 0) warnings.push(`Avoir ${e.number} et ${sameDay} paiement(s) de la facture ${inv.number} le même jour (${e.date.toISOString().slice(0, 10)}) : chronologie encaissement/avoir non prouvée (dates au jour) — catégorie fiscale ambiguë, déclaration de cette période refusée conservatoirement jusqu'à décision de l'expert-comptable.`)
          }
        }
        for (const part of allocated[i].parts) addRow(map, part.vatRateBp, part.baseCents, part.vatCents)
        if (allocated[i].excessCents > BigInt(0) && !excessWarned) {
          excessWarned = true
          const origin = e.event.kind === "CREDIT" ? `Avoir ${e.number} sur la facture ${inv.number} déjà encaissée` : `Facture ${inv.number} (mouvement du ${e.date.toISOString().slice(0, 10)})`
          warnings.push(`${origin} : ${centsToDecimalString(allocated[i].excessCents)} € encaissés au-delà de la facture nette de ses avoirs — la régularisation de la TVA encaissée n'intervient qu'au remboursement effectif (mouvement de trésorerie non pris en charge par le module) — à traiter avec l'expert-comptable.`)
        }
      })
      // U1 : mouvements de la période dont la ventilation dépend d'un avoir hors contrat daté d'une période ANTÉRIEURE (si l'avoir est dans
      // la période, son propre avertissement refuse déjà la période et l'explique).
      if (taint && dependent > 0 && !taintInPeriod) {
        const why = taint.kind === "prior" ? "après encaissement antérieur" : "le même jour qu'un encaissement (chronologie non prouvée)"
        warnings.push(`${dependent} mouvement(s) de trésorerie de la facture ${inv.number} dans la période : ventilation de la TVA par taux dépendante de la réaffectation non validée (avoir ${taint.credit.number} du ${taint.credit.date.toISOString().slice(0, 10)}, ${why}) — déclaration de cette période refusée tant que ce cas n'est pas résolu avec l'expert-comptable ; les mouvements antérieurs à l'avoir et les autres factures ne sont pas concernés.`)
      }
      if (late && dependentLate > 0) warnings.push(`${dependentLate} événement(s) de la facture ${inv.number} dans la période : allocation cumulative dépendante d'un ${late.source} du ${late.date.toISOString().slice(0, 10)} saisi après la déclaration de la période ${late.period} (événement absent de la déclaration figée, jamais réécrite) — déclaration de cette période refusée tant que la régularisation n'est pas traitée avec l'expert-comptable.`)
      if (inPeriodEvents > 0) documents++
    }
  }
  const supplier = await db.supplierInvoice.findMany({ where: { companyId, status: "VALIDATED", date: { gte: periodStart, lte: end } }, select: { vatCents: true } })
  const deductible = supplier.reduce((s, r) => s + r.vatCents, BigInt(0))
  const collected = [...map.values()].sort((a, b) => a.vatRateBp - b.vatRateBp)
  const collectedCents = collected.reduce((s, r) => s + r.vatCents, BigInt(0))
  // T2 : période(s) déjà déclarée(s) CHEVAUCHANT la période calculée — un événement saisi tardivement (paiement antidaté, avoir, pièce,
  // facture fournisseur) daté dans une période déclarée est signalé STRUCTURELLEMENT (création/émission postérieure à la déclaration), quel
  // que soit l'effet sur les totaux ; l'écart de totaux sur une période identique est aussi signalé. La déclaration figée n'est jamais
  // réécrite ; la régularisation relève d'une période ultérieure, à traiter avec l'expert-comptable.
  const declaredPeriods = await db.vatDeclaration.findMany({ where: { companyId, periodStart: { lte: end }, periodEnd: { gte: periodStart } }, select: { periodStart: true, periodEnd: true, basis: true, collectedCents: true, deductibleCents: true, declaredAt: true } })
  for (const d of declaredPeriods) {
    const dEnd = new Date(Date.UTC(d.periodEnd.getUTCFullYear(), d.periodEnd.getUTCMonth(), d.periodEnd.getUTCDate(), 23, 59, 59, 999))
    const label = `${d.periodStart.toISOString().slice(0, 10)} → ${d.periodEnd.toISOString().slice(0, 10)}${d.declaredAt ? `, déclarée le ${d.declaredAt.toISOString().slice(0, 10)}` : ""}`
    if (d.declaredAt) {
      const latePayments = d.basis === "ENCAISSEMENTS" ? await db.invoicePayment.count({ where: { companyId, paidAt: { gte: d.periodStart, lte: dEnd }, createdAt: { gt: d.declaredAt } } }) : 0
      const lateReversals = d.basis === "ENCAISSEMENTS" ? await db.invoicePayment.count({ where: { companyId, paidAt: { gte: d.periodStart, lte: dEnd }, reversedAt: { gt: d.declaredAt } } }) : 0
      const lateCredits = await db.invoice.count({ where: { companyId, kind: "CREDIT_NOTE", status: { in: ["SENT", "PAID"] }, issueDate: { gte: d.periodStart, lte: dEnd }, sentAt: { gt: d.declaredAt } } })
      const lateDocs = d.basis === "DEBITS" ? await db.invoice.count({ where: { companyId, kind: { not: "CREDIT_NOTE" }, status: { in: ["SENT", "PARTIAL", "PAID", "CANCELLED"] }, issueDate: { gte: d.periodStart, lte: dEnd }, sentAt: { gt: d.declaredAt } } }) : 0
      const lateSuppliers = await db.supplierInvoice.count({ where: { companyId, status: "VALIDATED", date: { gte: d.periodStart, lte: dEnd }, validatedAt: { gt: d.declaredAt } } })
      const late = latePayments + lateReversals + lateCredits + lateDocs + lateSuppliers
      if (late > 0) warnings.push(`Période déjà déclarée (${label}, ${d.basis}) : ${late} événement(s) saisi(s) après la déclaration et daté(s) dans cette période (paiements ${latePayments}, contre-passations ${lateReversals}, avoirs ${lateCredits}, pièces ${lateDocs}, factures fournisseurs ${lateSuppliers}) — la déclaration figée n'est pas réécrite ; régularisation à traiter sur une période ultérieure avec l'expert-comptable.`)
    }
    if (d.basis === basis && d.periodStart.getTime() === periodStart.getTime() && d.periodEnd.getTime() === periodEnd.getTime() && (d.collectedCents !== collectedCents || d.deductibleCents !== deductible)) {
      warnings.push(`Période déjà déclarée (${label}) : le recalcul (${centsToDecimalString(collectedCents)} € collectés, ${centsToDecimalString(deductible)} € déductibles) diffère de la déclaration figée (${centsToDecimalString(d.collectedCents)} € / ${centsToDecimalString(d.deductibleCents)} €) — la déclaration n'est pas réécrite.`)
    }
  }
  return { basis, periodStart, periodEnd, collected, collectedCents, deductibleCents: deductible, dueCents: collectedCents - deductible, documents, payments, adjustments, supplierInvoices: supplier.length, warnings }
}

