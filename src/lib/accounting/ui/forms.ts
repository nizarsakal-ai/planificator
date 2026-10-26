// Formulaires et messages du module Comptabilité (SPEC-ACC-A2). Pur : importable côté client et serveur.
import { z } from "zod"
import { MoneyError, parseAmountToCents } from "../engine/money"

/** "1 234,56" | "1234.56" | "" → centimes. Vide ⇒ 0. Refuse signe, lettres, plus de 2 décimales. */
export function amountInputToCents(raw: string): bigint {
  const s = raw.replace(/[\s  ]/g, "").replace(",", ".")
  if (s === "") return BigInt(0)
  return parseAmountToCents(s)
}

/** Centimes → "1 234,56 €" (affichage fr-FR, exact, sans flottant). */
export function formatEuros(cents: bigint): string {
  const neg = cents < BigInt(0)
  const abs = neg ? -cents : cents
  const units = (abs / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  const dec = (abs % BigInt(100)).toString().padStart(2, "0")
  return `${neg ? "−" : ""}${units},${dec} €`
}

const id = z.string().trim().min(1).max(64)
/** Date AAAA-MM-JJ réellement calendaire (refuse 2026-02-31, qui deviendrait le 03/03 en JS). */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}
export const isoDateSchema = z.string().refine(isCalendarDay, "Date invalide")
const isoDate = isoDateSchema
const text = (max: number) => z.string().trim().max(max)

export const entryFormSchema = z.object({
  journalId: id,
  fiscalYearId: id,
  entryDate: isoDate,
  documentDate: z.union([isoDate, z.literal("")]).optional(),
  documentRef: text(100).optional(),
  label: z.string().trim().min(1, "Libellé obligatoire").max(300),
  lines: z.array(z.object({
    accountId: id,
    label: text(300).optional(),
    debit: z.string().max(32),
    credit: z.string().max(32),
    vatRateBp: z.union([z.literal(""), z.string().regex(/^\d{1,5}$/)]).optional(),
  })).min(2, "Au moins deux lignes").max(500),
}).strict()

export type EntryFormInput = z.input<typeof entryFormSchema>

export interface ParsedEntry {
  journalId: string; fiscalYearId: string; entryDate: Date; documentDate: Date | null; documentRef: string | null; label: string
  lines: { accountId: string; label: string | null; debitCents: bigint; creditCents: bigint; vatRateBp: number | null }[]
}

const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`)

export function parseEntryForm(raw: unknown): { ok: true; value: ParsedEntry } | { ok: false; error: string } {
  const r = entryFormSchema.safeParse(raw)
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Saisie invalide" }
  const v = r.data
  const lines: ParsedEntry["lines"] = []
  for (const [i, l] of v.lines.entries()) {
    let debitCents: bigint, creditCents: bigint
    try { debitCents = amountInputToCents(l.debit); creditCents = amountInputToCents(l.credit) }
    catch (e) { if (e instanceof MoneyError) return { ok: false, error: `Ligne ${i + 1} : montant invalide` }; throw e }
    lines.push({ accountId: l.accountId, label: l.label ? l.label : null, debitCents, creditCents, vatRateBp: l.vatRateBp ? Number(l.vatRateBp) : null })
  }
  return { ok: true, value: {
    journalId: v.journalId, fiscalYearId: v.fiscalYearId, entryDate: toDate(v.entryDate),
    documentDate: v.documentDate ? toDate(v.documentDate) : null, documentRef: v.documentRef ? v.documentRef : null, label: v.label, lines,
  } }
}

export function entryTotals(lines: readonly { debit: string; credit: string }[]): { debitCents: bigint; creditCents: bigint; valid: boolean } {
  let debitCents = BigInt(0), creditCents = BigInt(0), valid = true
  for (const l of lines) {
    try { debitCents += amountInputToCents(l.debit); creditCents += amountInputToCents(l.credit) } catch { valid = false }
  }
  return { debitCents, creditCents, valid }
}

const MESSAGES: Record<string, string> = {
  ENTRY_INVALID: "Écriture invalide",
  TOO_FEW_LINES: "au moins deux lignes", LINE_AMOUNT_INVALID: "montant invalide", LINE_BOTH_SIDES: "une ligne ne peut pas avoir débit ET crédit",
  LINE_ZERO: "une ligne a un montant nul", UNBALANCED: "total débit ≠ total crédit", ACCOUNT_UNKNOWN: "compte inconnu",
  ACCOUNT_OTHER_COMPANY: "compte d'une autre société", ACCOUNT_INACTIVE: "compte désactivé", JOURNAL_OTHER_COMPANY: "journal d'une autre société",
  YEAR_OTHER_COMPANY: "exercice d'une autre société", DATE_OUTSIDE_YEAR: "date hors de l'exercice", YEAR_NOT_OPEN: "exercice non ouvert",
  VAT_RATE_INVALID: "taux de TVA invalide", TOO_MANY_LINES: "trop de lignes",
  ACCESS_REVOKED: "Accès refusé : droits administrateur requis.",
  ENTRY_NOT_FOUND: "Écriture introuvable.", ENTRY_NOT_DRAFT: "Seul un brouillon peut être supprimé.", ENTRY_NOT_VALIDATED: "Seule une écriture validée peut être contre-passée.",
  ENTRY_REVERSAL_INVALID: "Contre-passation impossible (déjà contre-passée ou incohérente).", ENTRY_CONFLICT: "L'écriture a été modifiée entre-temps, rechargez la page.",
  SOURCE_CONFLICT: "Conflit de source.", SOURCE_HASH_MISMATCH: "Le brouillon a été modifié depuis sa création.",
  LABEL_INVALID: "Libellé invalide.", LINES_INVALID: "Nombre de lignes invalide (2 à 500).",
  ACCOUNT_NUMBER_INVALID: "Numéro de compte invalide (3 à 10 chiffres, classe 1 à 8).", ACCOUNT_NUMBER_TAKEN: "Ce numéro de compte existe déjà.", ACCOUNT_NOT_FOUND: "Compte introuvable.",
  FISCAL_YEAR_INVALID: "Exercice invalide", FISCAL_YEAR_NOT_FOUND: "Exercice introuvable.", FISCAL_YEAR_TRANSITION_INVALID: "Changement d'état impossible.",
  FISCAL_YEAR_CONFLICT: "L'exercice a été modifié entre-temps, rechargez la page.",
  DATE_NOT_CALENDAR_DAY: "date invalide", END_BEFORE_START: "la fin précède le début", LONGER_THAN_24_MONTHS: "plus de 24 mois",
}

/** Message lisible pour une AccountingError (code + détails) ou une erreur de base connue. */
export function accountingErrorMessage(code: string, details: readonly string[] = []): string {
  const head = MESSAGES[code] ?? "Opération refusée."
  const extra = details.map((d) => MESSAGES[d] ?? d).filter(Boolean)
  return extra.length ? `${head} : ${extra.join(", ")}.` : head
}
