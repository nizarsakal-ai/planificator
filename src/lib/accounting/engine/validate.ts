// Validateur pur et déterministe d'une écriture (SPEC-ACC-A §3 ; A1-a). Aucune base, aucune horloge.
import { MAX_LINE_CENTS } from "./money"

export type FiscalYearState = "OPEN" | "CLOSING" | "CLOSED"
export type JournalKind = "SALES" | "PURCHASES" | "BANK" | "MISC"

export interface LineInput {
  accountId: string
  debitCents: bigint
  creditCents: bigint
  label?: string | null
  vatRateBp?: number | null
}

export interface ValidationContext {
  companyId: string
  entryDate: Date
  closingEntry: boolean
  journal: { companyId: string; kind: JournalKind }
  fiscalYear: { companyId: string; startDate: Date; endDate: Date; status: FiscalYearState }
  accounts: ReadonlyMap<string, { companyId: string; active: boolean }>
}

export type ValidationError =
  | "TOO_FEW_LINES" | "LINE_AMOUNT_INVALID" | "LINE_BOTH_SIDES" | "LINE_ZERO" | "UNBALANCED"
  | "ACCOUNT_UNKNOWN" | "ACCOUNT_OTHER_COMPANY" | "ACCOUNT_INACTIVE" | "JOURNAL_OTHER_COMPANY"
  | "YEAR_OTHER_COMPANY" | "DATE_OUTSIDE_YEAR" | "YEAR_NOT_OPEN" | "VAT_RATE_INVALID" | "TOO_MANY_LINES"

const day = (d: Date) => d.toISOString().slice(0, 10)

export function validateEntry(lines: readonly LineInput[], ctx: ValidationContext): ValidationError[] {
  const errors = new Set<ValidationError>()
  if (lines.length < 2) errors.add("TOO_FEW_LINES")
  if (lines.length > 500) errors.add("TOO_MANY_LINES")
  let debit = BigInt(0)
  let credit = BigInt(0)
  for (const l of lines) {
    if (typeof l.debitCents !== "bigint" || typeof l.creditCents !== "bigint" || l.debitCents < BigInt(0) || l.creditCents < BigInt(0)
        || l.debitCents > MAX_LINE_CENTS || l.creditCents > MAX_LINE_CENTS) {
      errors.add("LINE_AMOUNT_INVALID")
      continue
    }
    if (l.debitCents > BigInt(0) && l.creditCents > BigInt(0)) errors.add("LINE_BOTH_SIDES")
    if (l.debitCents === BigInt(0) && l.creditCents === BigInt(0)) errors.add("LINE_ZERO")
    if (l.vatRateBp != null && (!Number.isInteger(l.vatRateBp) || l.vatRateBp < 0 || l.vatRateBp > 10000)) errors.add("VAT_RATE_INVALID")
    debit += l.debitCents
    credit += l.creditCents
    const acc = ctx.accounts.get(l.accountId)
    if (!acc) errors.add("ACCOUNT_UNKNOWN")
    else if (acc.companyId !== ctx.companyId) errors.add("ACCOUNT_OTHER_COMPANY")
    else if (!acc.active) errors.add("ACCOUNT_INACTIVE")
  }
  if (debit !== credit) errors.add("UNBALANCED")
  if (ctx.journal.companyId !== ctx.companyId) errors.add("JOURNAL_OTHER_COMPANY")
  if (ctx.fiscalYear.companyId !== ctx.companyId) errors.add("YEAR_OTHER_COMPANY")
  const d = day(ctx.entryDate)
  if (d < day(ctx.fiscalYear.startDate) || d > day(ctx.fiscalYear.endDate)) errors.add("DATE_OUTSIDE_YEAR")
  const open = ctx.fiscalYear.status === "OPEN"
    || (ctx.fiscalYear.status === "CLOSING" && ctx.closingEntry && ctx.journal.kind === "MISC")
  if (!open) errors.add("YEAR_NOT_OPEN")
  return [...errors]
}
