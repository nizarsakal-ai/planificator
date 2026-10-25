// ═══════════════════════════════════════════════════════════════════════════
// Devis — service transactionnel (SPEC-BILLING-C1). Toutes les fonctions reçoivent le contexte autorisé
// (société + utilisateur de session) et vérifient que chantier, client et articles appartiennent à la société.
// Les effets externes (courriers) sont exécutés APRÈS la transaction et journalisés.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma, PrismaClient } from "@prisma/client"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { centsToDecimalString, decimalToCents, formatEuro, hundredthsToDecimalString, bpToPercentString } from "@/lib/billing/money"
import { sendBillingMail } from "@/lib/billing/mail/send"
import { quoteReminderMail, quoteSentMail } from "@/lib/billing/mail/templates"
import { appBaseUrl, getBillingSettings } from "@/lib/billing/settings"
import { buildCsv, type CsvCell } from "@/lib/accounting/ui/csv"
import {
  QUOTE_ERRORS, convertQuoteCore, replaceQuoteDraftCore, transitionQuoteCore,
  type LifecycleResult, type QuoteDraftHeader, type QuoteDraftLine,
} from "./quote-lifecycle.core"
import { generateSignatureToken, hashSignatureToken, isValidSignatureToken, signatureExpiry } from "./quote-signature"
import { candidateToParsedQuote, parseQuoteImport } from "./quote-import"
import { listQuotes, type QuoteListFilters } from "./quote-queries"
import type { ParsedQuote } from "./quote-schemas"

export interface QuoteContext { companyId: string; userId: string }
type Db = PrismaClient

const dateFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
export const QUOTE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Brouillon", SENT: "Envoyé", ACCEPTED: "Accepté", REFUSED: "Refusé", EXPIRED: "Expiré", CONVERTED: "Converti",
}

function toDraftLines(parsed: ParsedQuote): QuoteDraftLine[] {
  return parsed.lines.map((l, i) => ({
    articleId: l.articleId, designation: l.designation, description: l.description, unit: l.unit,
    quantity: hundredthsToDecimalString(l.quantityHundredths), unitPrice: centsToDecimalString(l.unitPriceCents),
    vatRate: bpToPercentString(l.vatRateBp), lineHT: centsToDecimalString(parsed.totals.lines[i].lineHTCents),
    discountBp: l.discountBp, position: i,
  }))
}

function toHeader(parsed: ParsedQuote): Omit<QuoteDraftHeader, "worksiteId" | "clientId"> {
  return {
    issueDate: parsed.issueDate, validUntil: parsed.validUntil, subject: parsed.subject, notes: parsed.notes, paymentTerms: parsed.paymentTerms,
    globalDiscountBp: parsed.globalDiscountBp, vatReverseCharge: parsed.vatReverseCharge,
    totalHT: centsToDecimalString(parsed.totals.totalHTCents), totalVAT: centsToDecimalString(parsed.totals.totalVATCents), totalTTC: centsToDecimalString(parsed.totals.totalTTCCents),
  }
}

/** Chantier (et son client) de la société ; articles référencés appartenant à la société. */
async function checkReferences(db: Db | Prisma.TransactionClient, ctx: QuoteContext, parsed: ParsedQuote): Promise<LifecycleResult<{ clientId: string }>> {
  const worksite = await db.worksite.findFirst({ where: { id: parsed.worksiteId, companyId: ctx.companyId }, select: { id: true, clientId: true } })
  if (!worksite) return { ok: false, error: "Chantier introuvable." }
  const articleIds = [...new Set(parsed.lines.map((l) => l.articleId).filter((a): a is string => !!a))]
  if (articleIds.length) {
    const n = await db.article.count({ where: { companyId: ctx.companyId, id: { in: articleIds } } })
    if (n !== articleIds.length) return { ok: false, error: "Article introuvable." }
  }
  return { ok: true, value: { clientId: worksite.clientId } }
}

export async function createQuote(db: Db, ctx: QuoteContext, parsed: ParsedQuote, extra: { importRef?: string | null } = {}): Promise<LifecycleResult<{ id: string; number: string }>> {
  const refs = await checkReferences(db, ctx, parsed)
  if (!refs.ok) return refs
  let validUntil = parsed.validUntil
  if (!validUntil) {
    const s = await getBillingSettings(db, ctx.companyId)
    validUntil = new Date(parsed.issueDate.getTime() + s.quoteValidityDays * 86_400_000)
  }
  const header = { ...toHeader(parsed), validUntil }
  const created = await db.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, ctx.companyId, "QUOTE", parsed.issueDate.getUTCFullYear())
    const q = await tx.quote.create({
      data: {
        companyId: ctx.companyId, worksiteId: parsed.worksiteId, clientId: refs.value.clientId, number, status: "DRAFT",
        createdById: ctx.userId, importRef: extra.importRef ?? null, ...header,
        lines: { create: toDraftLines(parsed) },
      },
      select: { id: true, number: true },
    })
    await tx.historyLog.create({
      data: { companyId: ctx.companyId, worksiteId: parsed.worksiteId, actorId: ctx.userId, action: "CREATED", entityType: "Quote", entityId: q.id, detail: `Devis ${q.number} créé (brouillon)`, newValue: { totalTTC: header.totalTTC } },
    })
    return q
  })
  return { ok: true, value: created }
}

export async function updateQuote(db: Db, ctx: QuoteContext, quoteId: string, parsed: ParsedQuote): Promise<LifecycleResult> {
  const refs = await checkReferences(db, ctx, parsed)
  if (!refs.ok) return refs
  return db.$transaction((tx) => replaceQuoteDraftCore(tx, {
    companyId: ctx.companyId, quoteId, actorId: ctx.userId,
    header: { ...toHeader(parsed), worksiteId: parsed.worksiteId, clientId: refs.value.clientId },
    lines: toDraftLines(parsed),
  }))
}

export async function deleteDraftQuote(db: Db, ctx: QuoteContext, quoteId: string): Promise<LifecycleResult> {
  return db.$transaction(async (tx) => {
    const q = await tx.quote.findFirst({ where: { id: quoteId, companyId: ctx.companyId }, select: { number: true, status: true, worksiteId: true } })
    if (!q) return { ok: false, error: QUOTE_ERRORS.notFound }
    if (q.status !== "DRAFT") return { ok: false, error: "Seul un brouillon peut être supprimé." }
    // Suppression conditionnelle du devis D'ABORD (les lignes suivent par cascade) : si le statut a changé entre-temps,
    // rien n'est touché. Un échec après une écriture lève une exception (ROLLBACK), jamais un simple retour.
    const d = await tx.quote.deleteMany({ where: { id: quoteId, companyId: ctx.companyId, status: "DRAFT" } })
    if (d.count !== 1) return { ok: false, error: QUOTE_ERRORS.conflict }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, worksiteId: q.worksiteId, actorId: ctx.userId, action: "DELETED", entityType: "Quote", entityId: quoteId, detail: `Brouillon de devis ${q.number} supprimé` } })
    return { ok: true, value: undefined }
  })
}

export async function duplicateQuote(db: Db, ctx: QuoteContext, quoteId: string, now: Date): Promise<LifecycleResult<{ id: string; number: string }>> {
  const src = await db.quote.findFirst({
    where: { id: quoteId, companyId: ctx.companyId },
    select: { worksiteId: true, clientId: true, subject: true, notes: true, paymentTerms: true, globalDiscountBp: true, vatReverseCharge: true, totalHT: true, totalVAT: true, totalTTC: true, number: true,
      lines: { orderBy: { position: "asc" }, select: { articleId: true, designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true, position: true } } },
  })
  if (!src) return { ok: false, error: QUOTE_ERRORS.notFound }
  const s = await getBillingSettings(db, ctx.companyId)
  const issueDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const created = await db.$transaction(async (tx) => {
    const number = await nextDocumentNumber(tx, ctx.companyId, "QUOTE", issueDate.getUTCFullYear())
    const q = await tx.quote.create({
      data: {
        companyId: ctx.companyId, worksiteId: src.worksiteId, clientId: src.clientId, number, status: "DRAFT", createdById: ctx.userId,
        issueDate, validUntil: new Date(issueDate.getTime() + s.quoteValidityDays * 86_400_000),
        subject: src.subject, notes: src.notes, paymentTerms: src.paymentTerms, globalDiscountBp: src.globalDiscountBp, vatReverseCharge: src.vatReverseCharge,
        totalHT: src.totalHT, totalVAT: src.totalVAT, totalTTC: src.totalTTC,
        lines: { create: src.lines.map((l) => ({ ...l })) },
      },
      select: { id: true, number: true },
    })
    await tx.historyLog.create({ data: { companyId: ctx.companyId, worksiteId: src.worksiteId, actorId: ctx.userId, action: "CREATED", entityType: "Quote", entityId: q.id, detail: `Devis ${q.number} créé par duplication de ${src.number}` } })
    return q
  })
  return { ok: true, value: created }
}

export interface SendQuoteResult { status: string; signatureUrl: string }

/** Envoi (DRAFT → SENT) ou renvoi (SENT) : nouveau jeton de signature à chaque envoi, courrier journalisé après COMMIT. */
export async function sendQuote(db: Db, ctx: QuoteContext, quoteId: string, now: Date): Promise<LifecycleResult<SendQuoteResult>> {
  const q = await db.quote.findFirst({
    where: { id: quoteId, companyId: ctx.companyId },
    select: { id: true, number: true, status: true, validUntil: true, totalTTC: true, client: { select: { name: true, email: true } }, company: { select: { name: true } } },
  })
  if (!q) return { ok: false, error: QUOTE_ERRORS.notFound }
  if (q.status !== "DRAFT" && q.status !== "SENT") return { ok: false, error: "Seul un devis brouillon ou envoyé peut être envoyé." }
  const to = q.client.email?.trim()
  if (!to) return { ok: false, error: QUOTE_ERRORS.noEmail }
  const { token, hash } = generateSignatureToken()
  const expires = signatureExpiry(q.validUntil, now)
  const data = { signatureTokenHash: hash, signatureTokenExpiresAt: expires }
  const r = await db.$transaction(async (tx) => {
    if (q.status === "DRAFT") return transitionQuoteCore(tx, { companyId: ctx.companyId, quoteId, to: "SENT", actorId: ctx.userId, now, data, detail: `Devis ${q.number} envoyé à ${to}` })
    const u = await tx.quote.updateMany({ where: { id: quoteId, companyId: ctx.companyId, status: "SENT" }, data })
    if (u.count !== 1) return { ok: false as const, error: QUOTE_ERRORS.conflict }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "Quote", entityId: quoteId, detail: `Devis ${q.number} renvoyé à ${to} (nouveau lien de signature)` } })
    return { ok: true as const, value: undefined }
  })
  if (!r.ok) return r
  const signatureUrl = `${appBaseUrl()}/devis-signature/${token}`
  const mail = quoteSentMail({ companyName: q.company.name, clientName: q.client.name, quoteNumber: q.number, totalTTC: formatEuro(decimalToCents(q.totalTTC)), validUntil: q.validUntil ? dateFr.format(q.validUntil) : "—", signatureUrl })
  const sent = await sendBillingMail(db, { companyId: ctx.companyId, kind: "QUOTE_SENT", documentType: "Quote", documentId: q.id }, { to, ...mail })
  return { ok: true, value: { status: sent.status, signatureUrl } }
}

export async function acceptQuoteManually(db: Db, ctx: QuoteContext, quoteId: string, now: Date): Promise<LifecycleResult> {
  const r = await db.$transaction((tx) => transitionQuoteCore(tx, { companyId: ctx.companyId, quoteId, to: "ACCEPTED", actorId: ctx.userId, now, data: { signerName: "Acceptation enregistrée manuellement" } }))
  return r.ok ? { ok: true, value: undefined } : r
}

export async function refuseQuote(db: Db, ctx: QuoteContext, quoteId: string, reason: string | null, now: Date): Promise<LifecycleResult> {
  const r = await db.$transaction((tx) => transitionQuoteCore(tx, { companyId: ctx.companyId, quoteId, to: "REFUSED", actorId: ctx.userId, now, data: { refusalReason: reason } }))
  return r.ok ? { ok: true, value: undefined } : r
}

export async function expireQuote(db: Db, ctx: QuoteContext, quoteId: string, now: Date): Promise<LifecycleResult> {
  const r = await db.$transaction((tx) => transitionQuoteCore(tx, { companyId: ctx.companyId, quoteId, to: "EXPIRED", actorId: ctx.userId, now }))
  return r.ok ? { ok: true, value: undefined } : r
}

export async function lockQuoteRow(tx: Prisma.TransactionClient, quoteId: string, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "quotes" WHERE "id" = ${quoteId} AND "companyId" = ${companyId} FOR UPDATE`
}

export async function convertQuote(db: Db, ctx: QuoteContext, quoteId: string, now: Date): Promise<LifecycleResult<{ invoiceId: string; invoiceNumber: string; existing: boolean }>> {
  const s = await getBillingSettings(db, ctx.companyId)
  return db.$transaction(async (tx) => {
    const r = await convertQuoteCore(tx, {
      companyId: ctx.companyId, quoteId, actorId: ctx.userId, now, paymentTermsDays: s.paymentTermsDays,
      nextDraftNumber: (t) => nextDocumentNumber(t, ctx.companyId, "INVOICE_DRAFT", now.getUTCFullYear()), lockQuote: lockQuoteRow,
    })
    if (r.ok && !r.value.existing) {
      // Lot C3 : déduction automatique des acomptes émis sur la facture de solde créée.
      const { applyDepositDeductionsCore } = await import("@/lib/billing/invoices/deposit.service")
      const d = await applyDepositDeductionsCore(tx, ctx, r.value.invoiceId)
      if (!d.ok) throw new Error(`DEPOSIT_DEDUCTION_FAILED: ${d.error}`)
    }
    if (r.ok) await flushDeferredConstraints(tx)
    return r
  })
}

// ─── Signature publique (sans session ; le jeton est la seule autorité) ──────

/**
 * Lecture publique : le contenu du devis n'est renvoyé que si le jeton est valide, non expiré et le devis SENT ;
 * sinon seul l'état (numéro, statut, société, dates de décision) est renvoyé pour afficher un message.
 */
export async function getQuoteForSignature(db: Db, token: unknown, now: Date) {
  if (!isValidSignatureToken(token)) return null
  const q = await db.quote.findFirst({
    where: { signatureTokenHash: hashSignatureToken(token) },
    select: {
      id: true, number: true, status: true, issueDate: true, validUntil: true, subject: true, notes: true, paymentTerms: true,
      totalHT: true, totalVAT: true, totalTTC: true, globalDiscountBp: true, vatReverseCharge: true, signatureTokenExpiresAt: true, signerName: true, signedAt: true, refusedAt: true,
      company: { select: { name: true, address: true, siret: true, email: true, phone: true } }, client: { select: { name: true } },
      lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true } },
    },
  })
  if (!q) return null
  const expired = !q.signatureTokenExpiresAt || q.signatureTokenExpiresAt < now
  const signable = q.status === "SENT" && !expired
  if (signable) return { ...q, tokenExpired: expired, signable: true as const }
  return {
    id: q.id, number: q.number, status: q.status, signerName: q.signerName, signedAt: q.signedAt, refusedAt: q.refusedAt, issueDate: q.issueDate,
    company: { name: q.company.name }, tokenExpired: expired, signable: false as const,
  }
}

export async function signQuoteByToken(db: Db, token: unknown, input: { signerName: string; ipHash: string | null; now: Date }): Promise<LifecycleResult> {
  if (!isValidSignatureToken(token)) return { ok: false, error: QUOTE_ERRORS.tokenInvalid }
  const name = input.signerName.trim().slice(0, 120)
  if (name.length < 2) return { ok: false, error: "Indiquez votre nom pour signer." }
  return db.$transaction(async (tx) => {
    const q = await tx.quote.findFirst({ where: { signatureTokenHash: hashSignatureToken(token) }, select: { id: true, companyId: true, createdById: true, number: true, status: true, signatureTokenExpiresAt: true } })
    if (!q || !q.signatureTokenExpiresAt || q.signatureTokenExpiresAt < input.now) return { ok: false, error: QUOTE_ERRORS.tokenInvalid }
    if (q.status !== "SENT") return { ok: false, error: QUOTE_ERRORS.notSent }
    const r = await transitionQuoteCore(tx, {
      companyId: q.companyId, quoteId: q.id, to: "ACCEPTED", actorId: q.createdById, now: input.now,
      data: { signerName: name, signedAt: input.now, signatureIpHash: input.ipHash }, detail: `Devis ${q.number} signé en ligne par ${name} (action du client via le lien public ; acteur technique = créateur du devis)`,
    })
    return r.ok ? { ok: true, value: undefined } : r
  })
}

export async function refuseQuoteByToken(db: Db, token: unknown, input: { reason: string | null; now: Date }): Promise<LifecycleResult> {
  if (!isValidSignatureToken(token)) return { ok: false, error: QUOTE_ERRORS.tokenInvalid }
  return db.$transaction(async (tx) => {
    const q = await tx.quote.findFirst({ where: { signatureTokenHash: hashSignatureToken(token) }, select: { id: true, companyId: true, createdById: true, number: true, status: true, signatureTokenExpiresAt: true } })
    if (!q || !q.signatureTokenExpiresAt || q.signatureTokenExpiresAt < input.now) return { ok: false, error: QUOTE_ERRORS.tokenInvalid }
    if (q.status !== "SENT") return { ok: false, error: QUOTE_ERRORS.notSent }
    const r = await transitionQuoteCore(tx, {
      companyId: q.companyId, quoteId: q.id, to: "REFUSED", actorId: q.createdById, now: input.now,
      data: { refusalReason: input.reason?.trim().slice(0, 500) || null }, detail: `Devis ${q.number} refusé en ligne par le client (action via le lien public ; acteur technique = créateur du devis)`,
    })
    return r.ok ? { ok: true, value: undefined } : r
  })
}

// ─── Import / export ───────────────────────────────────────────────────────

export interface ImportReport { imported: { reference: string; number: string }[]; skipped: { reference: string; reason: string }[]; invalid: { reference: string; rows: number[]; errors: string[] }[]; fatal?: string }

export async function importQuotes(db: Db, ctx: QuoteContext, text: string, now: Date): Promise<ImportReport> {
  const today = now.toISOString().slice(0, 10)
  const parsed = parseQuoteImport(text, today)
  const report: ImportReport = { imported: [], skipped: [], invalid: parsed.invalid, fatal: parsed.fatal }
  if (parsed.fatal) return report
  for (const c of parsed.candidates) {
    const existing = await db.quote.findFirst({ where: { companyId: ctx.companyId, importRef: c.reference }, select: { number: true } })
    if (existing) { report.skipped.push({ reference: c.reference, reason: `déjà importé (${existing.number})` }); continue }
    const worksite = await db.worksite.findFirst({ where: { companyId: ctx.companyId, name: c.worksiteName }, select: { id: true } })
    if (!worksite) { report.invalid.push({ reference: c.reference, rows: c.rowNumbers, errors: [`chantier « ${c.worksiteName} » introuvable`] }); continue }
    try {
      const r = await createQuote(db, ctx, candidateToParsedQuote(c, worksite.id), { importRef: c.reference })
      if (r.ok) report.imported.push({ reference: c.reference, number: r.value.number })
      else report.invalid.push({ reference: c.reference, rows: c.rowNumbers, errors: [r.error] })
    } catch (e) {
      // Course entre deux imports de la même référence : contrainte unique (companyId, importRef).
      const code = (e as { code?: string }).code
      if (code === "P2002") report.skipped.push({ reference: c.reference, reason: "déjà importé" })
      else throw e
    }
  }
  return report
}

export async function exportQuotesCsv(db: Db, companyId: string, filters: QuoteListFilters): Promise<string> {
  const header = ["Numéro", "Statut", "Date", "Validité", "Client", "Chantier", "Objet", "Total HT", "Total TTC", "Facture"]
  const rows: CsvCell[][] = []
  const MAX_PAGES = 200 // 10 000 lignes ; au-delà, une ligne finale signale la troncature.
  let truncated = false
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) { truncated = true; break }
    const r = await listQuotes(db, companyId, { ...filters, page })
    for (const q of r.rows) {
      rows.push([
        { text: q.number }, { text: QUOTE_STATUS_LABEL[q.status] ?? q.status }, { text: dateFr.format(q.issueDate) }, { text: q.validUntil ? dateFr.format(q.validUntil) : "" },
        { text: q.clientName }, { text: q.worksiteName }, { text: q.subject ?? "" }, { amount: q.totalHTCents }, { amount: q.totalTTCCents }, { text: q.invoice?.number ?? "" },
      ])
    }
    if (r.rows.length < r.pageSize) break
  }
  if (truncated) rows.push([{ text: "EXPORT TRONQUÉ : affinez les filtres (plus de 10 000 devis)" }])
  return buildCsv(header, rows)
}

// ─── Relances J+3 / J+7 / J+15 et expiration (job idempotent) ───────────────

export interface ReminderRunReport { expired: number; reminders: { step: number; sent: number }[] }

const STEPS: readonly { step: 3 | 7 | 15; column: "reminderJ3SentAt" | "reminderJ7SentAt" | "reminderJ15SentAt" }[] = [
  { step: 3, column: "reminderJ3SentAt" }, { step: 7, column: "reminderJ7SentAt" }, { step: 15, column: "reminderJ15SentAt" },
]

/**
 * 1. Expire les devis SENT dont la validité est dépassée (transition tracée, actor = créateur).
 * 2. Pour chaque devis SENT avec e-mail client, UN SEUL courrier par exécution : le palier le plus élevé dû
 *    (J+15 > J+7 > J+3) ; les paliers inférieurs non envoyés sont marqués « sautés » dans la même mise à jour
 *    conditionnelle (UPDATE … WHERE reminderJxSentAt IS NULL) ⇒ idempotent, jamais deux courriers simultanés.
 *    Le lien de signature n'est régénéré que s'il est expiré (sinon le lien du courrier précédent reste valable
 *    et le courrier de relance le rappelle sans nouveau lien).
 */
export async function runQuoteReminders(db: Db, now: Date, limit = 200): Promise<ReminderRunReport> {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const toExpire = await db.quote.findMany({ where: { status: "SENT", validUntil: { lt: today } }, select: { id: true, companyId: true, createdById: true }, take: limit })
  let expired = 0
  for (const q of toExpire) {
    const r = await db.$transaction((tx) => transitionQuoteCore(tx, { companyId: q.companyId, quoteId: q.id, to: "EXPIRED", actorId: q.createdById, now, detail: "Devis expiré (validité dépassée)" }))
    if (r.ok) expired++
  }
  const report: ReminderRunReport = { expired, reminders: STEPS.map(({ step }) => ({ step, sent: 0 })) }
  const threshold3 = new Date(now.getTime() - 3 * 86_400_000)
  const candidates = await db.quote.findMany({
    where: { status: "SENT", sentAt: { lte: threshold3 }, OR: [{ validUntil: null }, { validUntil: { gte: today } }], client: { email: { not: null } } },
    select: { id: true, companyId: true, number: true, sentAt: true, validUntil: true, totalTTC: true, reminderJ3SentAt: true, reminderJ7SentAt: true, reminderJ15SentAt: true, signatureTokenExpiresAt: true, client: { select: { name: true, email: true } }, company: { select: { name: true } } },
    take: limit,
  })
  for (const q of candidates) {
    const to = q.client.email?.trim()
    if (!to || !q.sentAt) continue
    const ageMs = now.getTime() - q.sentAt.getTime()
    // Paliers dus et non encore traités ; on envoie le plus élevé, les inférieurs sont marqués sautés.
    const dueSteps = STEPS.filter(({ step, column }) => ageMs >= step * 86_400_000 && q[column] === null)
    if (dueSteps.length === 0) continue
    const top = dueSteps[dueSteps.length - 1]
    const data: Record<string, Date | string> = {}
    for (const s of dueSteps) data[s.column] = now
    const where: Record<string, unknown> = { id: q.id, companyId: q.companyId, status: "SENT", [top.column]: null }
    const tokenExpired = !q.signatureTokenExpiresAt || q.signatureTokenExpiresAt < now
    let signatureUrl: string | null = null
    if (tokenExpired) {
      const { token, hash } = generateSignatureToken()
      data.signatureTokenHash = hash
      data.signatureTokenExpiresAt = signatureExpiry(q.validUntil, now)
      signatureUrl = `${appBaseUrl()}/devis-signature/${token}`
    }
    const claimed = await db.quote.updateMany({ where, data })
    if (claimed.count !== 1) continue
    const mail = quoteReminderMail({ step: top.step, companyName: q.company.name, clientName: q.client.name, quoteNumber: q.number, totalTTC: formatEuro(decimalToCents(q.totalTTC)), validUntil: q.validUntil ? dateFr.format(q.validUntil) : "—", signatureUrl })
    await sendBillingMail(db, { companyId: q.companyId, kind: `QUOTE_REMINDER_J${top.step}`, documentType: "Quote", documentId: q.id }, { to, ...mail })
    const row = report.reminders.find((r) => r.step === top.step)
    if (row) row.sent++
  }
  return report
}
