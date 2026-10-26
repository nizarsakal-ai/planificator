"use server"
// Server Actions du module Comptabilité (SPEC-ACC-A2 §3). Minces : garde de session, validation, service A1/A2
// dans une transaction rejouable, erreurs traduites. Le companyId vient TOUJOURS de la session.
import { revalidatePath } from "next/cache"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { requireAccountingAdmin } from "@/lib/accounting/access/accounting-access"
import { AccountingAccessError } from "@/lib/accounting/access/accounting-access.core"
import { AccountingError, createDraftEntry, postEntry, reverseEntry, type AccountingContext } from "@/lib/accounting/engine/posting"
import { advanceFiscalYear, openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { createAccount, deleteDraftEntry, initializeAccounting, setAccountActive } from "@/lib/accounting/engine/admin"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { accountingErrorMessage, isoDateSchema, parseEntryForm } from "@/lib/accounting/ui/forms"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }

async function context(): Promise<AccountingContext> {
  const c = await requireAccountingAdmin()
  return { companyId: c.companyId, userId: c.userId }
}

async function run<T>(fn: (ctx: AccountingContext) => Promise<T>): Promise<Result<{ value: T }>> {
  try {
    const ctx = await context()
    const value = await fn(ctx)
    revalidatePath("/comptabilite", "layout")
    return { ok: true, value }
  } catch (error) {
    if (error instanceof AccountingAccessError) return { ok: false, error: "Accès refusé." }
    if (error instanceof AccountingError) return { ok: false, error: accountingErrorMessage(error.code, error.details) }
    if (isUniqueViolation(error, "number")) return { ok: false, error: accountingErrorMessage("ACCOUNT_NUMBER_TAKEN") }
    const message = error instanceof Error ? error.message : ""
    const known = /\b(FISCAL_YEAR_OVERLAP|FISCAL_YEAR_IMMUTABLE|ENTRY_[A-Z_]+|ACCOUNT_IN_USE|ACCOUNT_IMMUTABLE)\b/.exec(message)?.[1]
    if (known === "FISCAL_YEAR_OVERLAP") return { ok: false, error: "Cet exercice chevauche un exercice existant." }
    if (known) return { ok: false, error: accountingErrorMessage(known) }
    console.error("[comptabilite] action en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

/** Violation d'unicité Prisma (P2002) portant sur la colonne donnée. */
function isUniqueViolation(error: unknown, column: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false
  const target = (error.meta as { target?: unknown } | undefined)?.target
  return Array.isArray(target) ? target.includes(column) : typeof target === "string" && target.includes(column)
}

const idSchema = z.string().trim().min(1).max(64)

export async function initializeAccountingAction(): Promise<Result> {
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => initializeAccounting(tx, ctx)))
  return r.ok ? { ok: true } : r
}

export async function openFiscalYearAction(raw: unknown): Promise<Result> {
  const p = z.object({ startDate: isoDateSchema, endDate: isoDateSchema }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Dates invalides." }
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => openFiscalYear(tx, ctx, {
    startDate: new Date(`${p.data.startDate}T00:00:00.000Z`), endDate: new Date(`${p.data.endDate}T00:00:00.000Z`),
  })))
  return r.ok ? { ok: true } : r
}

export async function advanceFiscalYearAction(raw: unknown): Promise<Result> {
  const p = z.object({ fiscalYearId: idSchema, to: z.enum(["CLOSING", "CLOSED"]), confirmation: z.string() }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  if (p.data.to === "CLOSED" && p.data.confirmation !== "CLÔTURER") return { ok: false, error: "Tapez CLÔTURER pour confirmer la clôture définitive." }
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => advanceFiscalYear(tx, ctx, p.data.fiscalYearId, p.data.to)))
  return r.ok ? { ok: true } : r
}

export async function createAccountAction(raw: unknown): Promise<Result> {
  const p = z.object({ number: z.string().max(20), label: z.string().max(200) }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Saisie invalide." }
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => createAccount(tx, ctx, p.data)))
  return r.ok ? { ok: true } : r
}

export async function setAccountActiveAction(raw: unknown): Promise<Result> {
  const p = z.object({ accountId: idSchema, active: z.boolean() }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => setAccountActive(tx, ctx, p.data.accountId, p.data.active)))
  return r.ok ? { ok: true } : r
}

/** Enregistre un brouillon ; avec validate=true, le valide dans la même transaction (tout ou rien). */
export async function saveEntryAction(raw: unknown, validate: boolean): Promise<Result<{ id: string; number: number | null }>> {
  const parsed = parseEntryForm(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const v = parsed.value
  const r = await run((ctx) => runAccountingTransaction(prisma, async (tx) => {
    const draft = await createDraftEntry(tx, ctx, {
      journalId: v.journalId, fiscalYearId: v.fiscalYearId, entryDate: v.entryDate, documentDate: v.documentDate, documentRef: v.documentRef,
      label: v.label, lines: v.lines.map((l) => ({ accountId: l.accountId, label: l.label, debitCents: l.debitCents, creditCents: l.creditCents, vatRateBp: l.vatRateBp })),
    })
    if (validate !== true) return { id: draft.id, number: null }
    const posted = await postEntry(tx, ctx, draft.id)
    return { id: posted.id, number: posted.number }
  }))
  return r.ok ? { ok: true, id: r.value.id, number: r.value.number } : r
}

export async function postEntryAction(entryId: unknown): Promise<Result<{ number: number }>> {
  const p = idSchema.safeParse(entryId)
  if (!p.success) return { ok: false, error: "Écriture introuvable." }
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => postEntry(tx, ctx, p.data)))
  return r.ok ? { ok: true, number: r.value.number } : r
}

export async function deleteDraftAction(entryId: unknown): Promise<Result> {
  const p = idSchema.safeParse(entryId)
  if (!p.success) return { ok: false, error: "Écriture introuvable." }
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => deleteDraftEntry(tx, ctx, p.data)))
  return r.ok ? { ok: true } : r
}

export async function reverseEntryAction(raw: unknown): Promise<Result<{ id: string; number: number }>> {
  const p = z.object({ entryId: idSchema, entryDate: isoDateSchema, fiscalYearId: idSchema }).strict().safeParse(raw)
  if (!p.success) return { ok: false, error: "Demande invalide." }
  const r = await run((ctx) => runAccountingTransaction(prisma, (tx) => reverseEntry(tx, ctx, p.data.entryId, {
    entryDate: new Date(`${p.data.entryDate}T00:00:00.000Z`), fiscalYearId: p.data.fiscalYearId,
  })))
  return r.ok ? { ok: true, id: r.value.id, number: r.value.number } : r
}
