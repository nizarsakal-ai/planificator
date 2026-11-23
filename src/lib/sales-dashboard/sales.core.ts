/**
 * Lot D Planificator V2 : tableaux de bord commerciaux — indicateurs PURS (centimes BigInt, taux en points de base).
 *
 * Période : demi-ouverte [début, fin) en jours civils de Paris. Par défaut, les 12 derniers mois civils, mois en cours
 * inclus jusqu'au jour courant (Paris) ; ou une année civile (« 2026 »).
 *
 * Définitions (chacune testée sur un jeu fictif) :
 * - DEVIS ÉMIS : devis non brouillons (envoyé, accepté, refusé, expiré, converti) dont la date d'émission tombe dans
 *   la période. Nombre et montant HT.
 * - DEVIS SIGNÉS : parmi les émis de la période, acceptés ou convertis en facture.
 * - TAUX DE TRANSFORMATION : signés / décidés, où décidés = signés + refusés + expirés. Les devis encore en attente
 *   (envoyés) sont exclus du dénominateur. En nombre et en montant HT. Indéfini (—) si aucun devis décidé.
 * - CHIFFRE D'AFFAIRES FACTURÉ HT (même règle que le « facturé » du lot C) : pièces ÉMISES (`sentAt` renseigné, jamais
 *   le statut courant) — factures et acomptes — moins avoirs émis, par date d'ÉMISSION dans la période. La facture de
 *   solde est NETTE de l'acompte déduit (lignes de déduction négatives) : acompte 300 + solde net 700 = 1 000. Une
 *   facture annulée par avoir total reste émise et son avoir la compense : contribution nette 0. Brouillons exclus ;
 *   PAIEMENTS EXCLUS (aucune date ni montant de paiement n'est lu). Série mensuelle, classement des 10 premiers clients
 *   et des 10 premiers chantiers ; les ventilations complètes (mois, clients, chantiers) somment exactement au total.
 * - ARTICLES LES PLUS VENDUS : montant HT des LIGNES D'ARTICLES facturées, HORS déduction d'acompte, avoirs déduits.
 *   Retenues : lignes avec article des factures émises de nature INVOICE ; déduites : lignes avec article des avoirs
 *   émis (CREDIT_NOTE). Dans la facturation actuelle, seul l'avoir TOTAL recopie les articles de l'origine ; un avoir
 *   PARTIEL (par lignes ou par montant) ne porte aucun article : il réduit le chiffre d'affaires, pas le classement des
 *   articles (limite affichée, aucune attribution inventée). Exclues : toute pièce de nature DEPOSIT (même si une ligne porte un article : un acompte n'est
 *   pas une vente d'article), toute ligne de déduction d'acompte, les lignes sans article. La déduction d'acompte n'est
 *   PAS ventilée par article : la somme des articles n'est donc pas le chiffre d'affaires net (aucune égalité imposée).
 *   Quantité et montant calculés séparément ; classées par montant HT, puis quantité ; 10 premiers.
 * Lecture seule de la facturation : aucune donnée Finance n'est modifiée par ces indicateurs.
 */
import { businessDay } from "@/lib/time/business-day"

export type QuoteStatus = "DRAFT" | "SENT" | "ACCEPTED" | "REFUSED" | "EXPIRED" | "CONVERTED"
export type InvoiceKind = "INVOICE" | "CREDIT_NOTE" | "DEPOSIT"
const DAY = 86_400_000

export interface Period { from: Date; to: Date; label: string }

/** « 2026 » ⇒ année civile ; sinon du 1er jour du mois d'il y a 11 mois jusqu'au jour courant (Paris) inclus. */
export function periodFor(param: string | null | undefined, now: Date): Period {
  const today = businessDay(now)
  const m = /^(20\d{2})$/.exec((param ?? "").trim())
  if (m) {
    const y = Number(m[1])
    return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)), label: `Année ${y}` }
  }
  const to = new Date(today.getTime() + DAY)
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1))
  return { from, to, label: "12 derniers mois" }
}
const inPeriod = (d: Date, p: Period) => { const day = businessDay(d).getTime(); return day >= p.from.getTime() && day < p.to.getTime() }
const monthKey = (d: Date) => businessDay(d).toISOString().slice(0, 7)

/** Mois « AAAA-MM » couverts par la période, dans l'ordre (série complète, mois sans facture à zéro). */
export function monthsOf(p: Period): string[] {
  const out: string[] = []
  let y = p.from.getUTCFullYear(), mo = p.from.getUTCMonth()
  while (Date.UTC(y, mo, 1) < p.to.getTime()) {
    out.push(`${y}-${String(mo + 1).padStart(2, "0")}`)
    mo++; if (mo === 12) { mo = 0; y++ }
  }
  return out
}

export function ratioBp(n: bigint, d: bigint): number | null {
  if (d <= BigInt("0")) return null
  return Number((n * BigInt("20000") + d) / (BigInt("2") * d))
}

export interface SalesFacts {
  quotes: readonly { status: QuoteStatus; issueDate: Date; totalHTCents: bigint }[]
  invoices: readonly { id: string; kind: InvoiceKind; issued: boolean; issueDate: Date; totalHTCents: bigint; clientId: string; clientName: string; worksiteId: string; worksiteName: string }[]
  lines: readonly { invoiceId: string; articleId: string | null; deductsDeposit: boolean; designation: string; quantityMilli: bigint; lineHTCents: bigint }[]
}

export interface Ranked { id: string; name: string; amountCents: bigint; quantityMilli?: bigint }
export interface SalesIndicators {
  period: Period
  quotes: { emitted: number; emittedCents: bigint; signed: number; signedCents: bigint; pending: number; decided: number; decidedCents: bigint; conversionBp: number | null; conversionValueBp: number | null }
  revenue: { totalCents: bigint; invoicesCount: number; depositsCount: number; creditNotesCount: number; byMonth: { month: string; amountCents: bigint }[]; byClient: Ranked[]; byWorksite: Ranked[] }
  topClients: Ranked[]
  topWorksites: Ranked[]
  topArticles: Required<Ranked>[]
}

const TOP = 10
/** Ventilation COMPLÈTE (non tronquée, montants nuls compris) : sa somme est exactement le total. */
function allOf(m: Map<string, Ranked>): Ranked[] {
  return [...m.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
function rank(m: Map<string, Ranked>): Ranked[] {
  return [...m.values()].filter((r) => r.amountCents !== BigInt("0"))
    .sort((a, b) => (a.amountCents === b.amountCents ? a.name.localeCompare(b.name, "fr") || (a.id < b.id ? -1 : 1) : a.amountCents > b.amountCents ? -1 : 1))
    .slice(0, TOP)
}

export function computeSalesIndicators(f: SalesFacts, period: Period): SalesIndicators {
  // Devis.
  let emitted = 0, signed = 0, pending = 0, decided = 0
  let emittedCents = BigInt("0"), signedCents = BigInt("0"), decidedCents = BigInt("0")
  for (const q of f.quotes) {
    if (q.status === "DRAFT" || !inPeriod(q.issueDate, period)) continue
    emitted++; emittedCents += q.totalHTCents
    if (q.status === "ACCEPTED" || q.status === "CONVERTED") { signed++; signedCents += q.totalHTCents }
    if (q.status === "SENT") pending++
    else { decided++; decidedCents += q.totalHTCents }
  }

  // Chiffre d'affaires (factures émises de la période).
  const months = new Map(monthsOf(period).map((m) => [m, BigInt("0")]))
  const clients = new Map<string, Ranked>(), sites = new Map<string, Ranked>()
  const sign = new Map<string, 1n | -1n>()
  const articleSign = new Map<string, 1n | -1n>()
  let total = BigInt("0"), invoicesCount = 0, depositsCount = 0, creditNotesCount = 0
  for (const i of f.invoices) {
    if (!i.issued || !inPeriod(i.issueDate, period)) continue
    const s = i.kind === "CREDIT_NOTE" ? (-BigInt("1") as -1n) : (BigInt("1") as 1n)
    sign.set(i.id, s)
    // Articles : jamais une pièce d'acompte (DEPOSIT), quelle que soit la présence d'un article sur ses lignes.
    if (i.kind !== "DEPOSIT") articleSign.set(i.id, s)
    const amount = s * i.totalHTCents
    total += amount
    if (i.kind === "CREDIT_NOTE") creditNotesCount++; else if (i.kind === "DEPOSIT") depositsCount++; else invoicesCount++
    const key = monthKey(i.issueDate)
    months.set(key, (months.get(key) ?? BigInt("0")) + amount)
    const c = clients.get(i.clientId) ?? { id: i.clientId, name: i.clientName, amountCents: BigInt("0") }
    c.amountCents += amount; clients.set(i.clientId, c)
    const w = sites.get(i.worksiteId) ?? { id: i.worksiteId, name: i.worksiteName, amountCents: BigInt("0") }
    w.amountCents += amount; sites.set(i.worksiteId, w)
  }

  // Articles (lignes des pièces retenues ci-dessus seulement).
  const articles = new Map<string, Required<Ranked>>()
  for (const l of f.lines) {
    const s = articleSign.get(l.invoiceId)
    if (!s || !l.articleId || l.deductsDeposit) continue
    const a = articles.get(l.articleId) ?? { id: l.articleId, name: l.designation, amountCents: BigInt("0"), quantityMilli: BigInt("0") }
    a.amountCents += s * l.lineHTCents
    a.quantityMilli += s * l.quantityMilli
    articles.set(l.articleId, a)
  }
  const topArticles = [...articles.values()].filter((a) => a.amountCents !== BigInt("0") || a.quantityMilli !== BigInt("0"))
    .sort((a, b) => (a.amountCents !== b.amountCents ? (a.amountCents > b.amountCents ? -1 : 1) : a.quantityMilli !== b.quantityMilli ? (a.quantityMilli > b.quantityMilli ? -1 : 1) : a.name.localeCompare(b.name, "fr") || (a.id < b.id ? -1 : 1)))
    .slice(0, TOP)

  return {
    period,
    quotes: { emitted, emittedCents, signed, signedCents, pending, decided, decidedCents, conversionBp: ratioBp(BigInt(signed), BigInt(decided)), conversionValueBp: ratioBp(signedCents, decidedCents) },
    revenue: { totalCents: total, invoicesCount, depositsCount, creditNotesCount, byMonth: [...months.entries()].map(([month, amountCents]) => ({ month, amountCents })), byClient: allOf(clients), byWorksite: allOf(sites) },
    topClients: rank(clients),
    topWorksites: rank(sites),
    topArticles,
  }
}

/** Quantité décimale (2 décimales en base) → millièmes, sans flottant. */
export function decimalToMilli(value: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim())
  if (!m) throw new RangeError("quantité invalide")
  const milli = BigInt(m[2]) * BigInt("1000") + BigInt((m[3] ?? "").padEnd(3, "0"))
  return m[1] ? -milli : milli
}
