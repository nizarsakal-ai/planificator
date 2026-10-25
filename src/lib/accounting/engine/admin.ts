// Administration du référentiel et des brouillons (SPEC-ACC-A2 §3). Mêmes règles qu'A1 :
// contexte autorisé (société + utilisateur de session), ADMIN revérifié sous verrou, audit HistoryLog.
// Une écriture validée n'est jamais supprimable (refus aussi en base : journal_entries_guard).
import type { Prisma } from "@prisma/client"
import { AccountingError, assertStillAccountingAdmin, type AccountingContext } from "./posting"
import { ensureBaseReferential } from "./setup"

type Tx = Prisma.TransactionClient

const ACCOUNT_NUMBER = /^[1-8][0-9]{2,9}$/

/** Initialise (idempotent) le plan de comptes de base et les journaux VT/HA/BQ/OD. */
export async function initializeAccounting(tx: Tx, ctx: AccountingContext): Promise<void> {
  await assertStillAccountingAdmin(tx, ctx)
  await ensureBaseReferential(tx, ctx)
}

export async function createAccount(tx: Tx, ctx: AccountingContext, input: { number: string; label: string }): Promise<{ id: string }> {
  await assertStillAccountingAdmin(tx, ctx)
  const number = input.number.trim()
  const label = input.label.trim()
  if (!ACCOUNT_NUMBER.test(number)) throw new AccountingError("ACCOUNT_NUMBER_INVALID")
  if (!label || label.length > 200 || /[\u0000-\u001f]/.test(label)) throw new AccountingError("LABEL_INVALID")
  const existing = await tx.accountingAccount.findFirst({ where: { companyId: ctx.companyId, number }, select: { id: true } })
  if (existing) throw new AccountingError("ACCOUNT_NUMBER_TAKEN")
  const account = await tx.accountingAccount.create({ data: { companyId: ctx.companyId, number, label }, select: { id: true } })
  await tx.historyLog.create({
    data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "AccountingAccount", entityId: account.id, detail: `Compte ${number} créé`, newValue: { number, label } },
  })
  return account
}

export async function setAccountActive(tx: Tx, ctx: AccountingContext, accountId: string, active: boolean): Promise<void> {
  await assertStillAccountingAdmin(tx, ctx)
  const updated = await tx.accountingAccount.updateMany({ where: { id: accountId, companyId: ctx.companyId }, data: { active } })
  if (updated.count !== 1) throw new AccountingError("ACCOUNT_NOT_FOUND")
  await tx.historyLog.create({
    data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "AccountingAccount", entityId: accountId, detail: active ? "Compte activé" : "Compte désactivé", newValue: { active } },
  })
}

/** Supprime un brouillon et ses lignes. Refusé pour une écriture validée (service et base). */
export async function deleteDraftEntry(tx: Tx, ctx: AccountingContext, entryId: string): Promise<void> {
  await assertStillAccountingAdmin(tx, ctx)
  const locked = await tx.$queryRaw<{ status: string; label: string }[]>`
    SELECT "status"::text AS status, "label" FROM "journal_entries" WHERE "id" = ${entryId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  if (locked.length !== 1) throw new AccountingError("ENTRY_NOT_FOUND")
  if (locked[0].status !== "DRAFT") throw new AccountingError("ENTRY_NOT_DRAFT")
  await tx.journalEntryLine.deleteMany({ where: { entryId, companyId: ctx.companyId } })
  const deleted = await tx.journalEntry.deleteMany({ where: { id: entryId, companyId: ctx.companyId, status: "DRAFT" } })
  if (deleted.count !== 1) throw new AccountingError("ENTRY_CONFLICT")
  await tx.historyLog.create({
    data: { companyId: ctx.companyId, actorId: ctx.userId, action: "DELETED", entityType: "JournalEntry", entityId: entryId, detail: "Brouillon d'écriture supprimé", oldValue: { label: locked[0].label } },
  })
}
