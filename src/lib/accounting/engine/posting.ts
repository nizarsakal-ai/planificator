// Service transactionnel du moteur comptable (SPEC-ACC-A ; A1-b).
// Toutes les fonctions reçoivent le client de transaction Prisma et le contexte autorisé
// (société + utilisateur issus de requireAccountingAdmin) ; elles ne lisent jamais d'entrée société client.
import type { Prisma } from "@prisma/client"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { resolveCompanyAccess } from "@/lib/company-access"
import { canonicalJson, entryHash, genesisHash, sha256Hex } from "./canonical"
import { validateEntry, type JournalKind, type LineInput, type ValidationError } from "./validate"

export interface AccountingContext {
  companyId: string
  userId: string
}

export class AccountingError extends Error {
  constructor(readonly code: string, readonly details: readonly string[] = []) {
    super(details.length ? `${code}: ${details.join(", ")}` : code)
    this.name = "AccountingError"
  }
}

type Tx = Prisma.TransactionClient

/**
 * Protection contre une révocation concurrente : dans la transaction, l'utilisateur doit toujours
 * disposer d'un accès ADMIN actif à cette société (même règle que la session : resolveCompanyAccess),
 * sans repli silencieux vers une autre société.
 */
export async function assertStillAccountingAdmin(tx: Tx, ctx: AccountingContext): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: ctx.userId },
    select: {
      role: true, active: true, companyId: true,
      company: { select: { active: true } },
      employeeProfiles: { select: { companyId: true, active: true, role: true, company: { select: { active: true } } } },
    },
  })
  if (!user || !user.active) throw new AccountingError("ACCESS_REVOKED")
  const access = resolveCompanyAccess(user, ctx.companyId)
  if (!access || access.companyId !== ctx.companyId || access.role !== "ADMIN") throw new AccountingError("ACCESS_REVOKED")
}

export interface DraftInput {
  journalId: string
  fiscalYearId: string
  entryDate: Date
  documentDate?: Date | null
  documentRef?: string | null
  label: string
  closingEntry?: boolean
  lines: LineInput[]
  source?: { type: string; id: string; version: number } | null
  reversalOfId?: string | null
}

/** Empreinte canonique du contenu métier d'une écriture sourcée (idempotence). */
export function sourcePayloadHash(input: DraftInput): string {
  return sha256Hex(canonicalJson({
    version: 1,
    journalId: input.journalId,
    fiscalYearId: input.fiscalYearId,
    entryDate: input.entryDate.toISOString().slice(0, 10),
    documentDate: input.documentDate ? input.documentDate.toISOString().slice(0, 10) : null,
    documentRef: input.documentRef ?? null,
    label: input.label,
    closingEntry: input.closingEntry ?? false,
    reversalOfId: input.reversalOfId ?? null,
    lines: input.lines.map((l, i) => ({
      position: i, accountId: l.accountId, label: l.label ?? null,
      debitCents: l.debitCents.toString(), creditCents: l.creditCents.toString(), vatRateBp: l.vatRateBp ?? null,
    })),
  }))
}

function checkLabel(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AccountingError("LABEL_INVALID")
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new AccountingError("LABEL_INVALID")
  return value
}

/**
 * Crée une écriture brouillon. Écriture sourcée : même clé + même empreinte ⇒ renvoie l'existante ;
 * empreinte différente ⇒ SOURCE_CONFLICT (jamais d'écrasement, pas de retry).
 */
export async function createDraftEntry(tx: Tx, ctx: AccountingContext, input: DraftInput): Promise<{ id: string; existing: boolean }> {
  await assertStillAccountingAdmin(tx, ctx)
  const label = checkLabel(input.label, 300)
  if (input.lines.length < 2 || input.lines.length > 500) throw new AccountingError("LINES_INVALID")
  if (input.source) {
    if (!input.source.type || !input.source.id || !Number.isSafeInteger(input.source.version) || input.source.version < 0) {
      throw new AccountingError("SOURCE_INVALID")
    }
    const hash = sourcePayloadHash(input)
    const existing = await tx.journalEntry.findFirst({
      where: { companyId: ctx.companyId, sourceType: input.source.type, sourceId: input.source.id, sourceVersion: input.source.version },
      select: { id: true, sourceHash: true },
    })
    if (existing) {
      if (existing.sourceHash !== hash) throw new AccountingError("SOURCE_CONFLICT")
      return { id: existing.id, existing: true }
    }
  }
  const created = await tx.journalEntry.create({
    data: {
      companyId: ctx.companyId,
      journalId: input.journalId,
      fiscalYearId: input.fiscalYearId,
      entryDate: input.entryDate,
      documentDate: input.documentDate ?? null,
      documentRef: input.documentRef ?? null,
      label,
      closingEntry: input.closingEntry ?? false,
      reversalOfId: input.reversalOfId ?? null,
      sourceType: input.source?.type ?? null,
      sourceId: input.source?.id ?? null,
      sourceVersion: input.source?.version ?? null,
      sourceHash: input.source ? sourcePayloadHash(input) : null,
      createdById: ctx.userId,
      lines: {
        // companyId des lignes : hérité de l'écriture via la FK composite (companyId, entryId).
        create: input.lines.map((l, i) => ({
          accountId: l.accountId,
          position: i,
          label: l.label ?? null,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          vatRateBp: l.vatRateBp ?? null,
        })),
      },
    },
    select: { id: true },
  })
  return { id: created.id, existing: false }
}

/**
 * Valide une écriture : verrous dans l'ordre unique FiscalYear → écriture → séquence → tête de chaîne,
 * contrôles, numéro sans trou, chaînage. Idempotent : une écriture déjà validée est renvoyée telle quelle.
 */
export async function postEntry(tx: Tx, ctx: AccountingContext, entryId: string, now: Date = new Date()): Promise<{ id: string; number: number; hash: string }> {
  await assertStillAccountingAdmin(tx, ctx)
  const head = await tx.journalEntry.findFirst({
    where: { id: entryId, companyId: ctx.companyId },
    select: { fiscalYearId: true },
  })
  if (!head) throw new AccountingError("ENTRY_NOT_FOUND")

  // 1. Verrou de l'exercice (sérialise validations et changement d'état de l'exercice), puis de l'écriture.
  //    FOR NO KEY UPDATE : compatible avec les verrous FOR KEY SHARE pris par les FK des insertions
  //    (évite l'interblocage brouillon/validation), exclusif entre validations et avec l'UPDATE de clôture.
  await tx.$queryRaw`SELECT 1 FROM "fiscal_years" WHERE "id" = ${head.fiscalYearId} AND "companyId" = ${ctx.companyId} FOR NO KEY UPDATE`
  await tx.$queryRaw`SELECT 1 FROM "journal_entries" WHERE "id" = ${entryId} AND "companyId" = ${ctx.companyId} FOR NO KEY UPDATE`

  const entry = await tx.journalEntry.findFirst({
    where: { id: entryId, companyId: ctx.companyId },
    include: {
      lines: { orderBy: { position: "asc" } },
      journal: { select: { companyId: true, kind: true } },
      fiscalYear: { select: { companyId: true, startDate: true, endDate: true, status: true } },
    },
  })
  if (!entry) throw new AccountingError("ENTRY_NOT_FOUND")
  if (entry.status === "VALIDATED") return { id: entry.id, number: entry.number!, hash: entry.hash! }

  const accounts = await tx.accountingAccount.findMany({
    where: { companyId: ctx.companyId, id: { in: [...new Set(entry.lines.map((l) => l.accountId))] } },
    select: { id: true, companyId: true, active: true },
  })
  const errors: ValidationError[] = validateEntry(
    entry.lines.map((l) => ({ accountId: l.accountId, debitCents: l.debitCents, creditCents: l.creditCents, vatRateBp: l.vatRateBp })),
    {
      companyId: ctx.companyId,
      entryDate: entry.entryDate,
      closingEntry: entry.closingEntry,
      journal: { companyId: entry.journal.companyId, kind: entry.journal.kind as JournalKind },
      fiscalYear: entry.fiscalYear,
      accounts: new Map(accounts.map((a) => [a.id, { companyId: a.companyId, active: a.active }])),
    }
  )
  if (errors.length) throw new AccountingError("ENTRY_INVALID", errors)
  if (entry.reversalOfId) await assertMirrorOf(tx, ctx, entry.reversalOfId, entry.lines)

  // 2. Autorise les écritures protégées pour CETTE transaction uniquement.
  await tx.$executeRaw`SELECT set_config('planificator.accounting_posting', 'on', true)`

  // 3. Numérotation : compteur créé à 0 si absent, verrouillé, incrémenté de 1.
  await tx.$executeRaw`INSERT INTO "accounting_sequences" ("companyId", "journalId", "fiscalYearId", "lastNumber")
    VALUES (${ctx.companyId}, ${entry.journalId}, ${entry.fiscalYearId}, 0) ON CONFLICT DO NOTHING`
  const seq = await tx.$queryRaw<{ lastNumber: number }[]>`SELECT "lastNumber" FROM "accounting_sequences"
    WHERE "companyId" = ${ctx.companyId} AND "journalId" = ${entry.journalId} AND "fiscalYearId" = ${entry.fiscalYearId} FOR NO KEY UPDATE`
  const number = Number(seq[0].lastNumber) + 1
  await tx.$executeRaw`UPDATE "accounting_sequences" SET "lastNumber" = ${number}
    WHERE "companyId" = ${ctx.companyId} AND "journalId" = ${entry.journalId} AND "fiscalYearId" = ${entry.fiscalYearId}`

  // 4. Tête de chaîne (par société × journal, traverse les exercices).
  const genesis = genesisHash(ctx.companyId, entry.journalId)
  await tx.$executeRaw`INSERT INTO "accounting_chain_heads" ("companyId", "journalId", "lastEntryId", "lastHash")
    VALUES (${ctx.companyId}, ${entry.journalId}, NULL, ${genesis}) ON CONFLICT DO NOTHING`
  const chain = await tx.$queryRaw<{ lastEntryId: string | null; lastHash: string }[]>`SELECT "lastEntryId", "lastHash"
    FROM "accounting_chain_heads" WHERE "companyId" = ${ctx.companyId} AND "journalId" = ${entry.journalId} FOR NO KEY UPDATE`
  const prevHash = chain[0].lastHash
  const validatedAt = new Date(Math.floor(now.getTime() / 1000) * 1000)
  const hash = entryHash({
    companyId: ctx.companyId, journalId: entry.journalId, fiscalYearId: entry.fiscalYearId, number,
    entryDate: entry.entryDate, documentDate: entry.documentDate, documentRef: entry.documentRef, label: entry.label,
    validatedAt, validatedById: ctx.userId, sourceType: entry.sourceType, sourceId: entry.sourceId,
    sourceVersion: entry.sourceVersion, reversalOfId: entry.reversalOfId, closingEntry: entry.closingEntry,
    lines: entry.lines.map((l) => ({ position: l.position, accountId: l.accountId, label: l.label, debitCents: l.debitCents, creditCents: l.creditCents, vatRateBp: l.vatRateBp })),
  }, prevHash)

  const updated = await tx.journalEntry.updateMany({
    where: { id: entry.id, companyId: ctx.companyId, status: "DRAFT" },
    data: { status: "VALIDATED", number, validatedAt, validatedById: ctx.userId, prevHash, prevEntryId: chain[0].lastEntryId, hash },
  })
  if (updated.count !== 1) throw new AccountingError("ENTRY_CONFLICT")
  await tx.$executeRaw`UPDATE "accounting_chain_heads" SET "lastEntryId" = ${entry.id}, "lastHash" = ${hash}
    WHERE "companyId" = ${ctx.companyId} AND "journalId" = ${entry.journalId}`
  // 5. Audit (même transaction : rollback ⇒ aucune trace orpheline). Aucune donnée personnelle.
  await tx.historyLog.create({
    data: {
      companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "JournalEntry", entityId: entry.id,
      detail: `Écriture n° ${number} validée${entry.reversalOfId ? " (contre-passation)" : ""}${entry.closingEntry ? " (OD de clôture)" : ""}`,
      newValue: { status: "VALIDATED", journalId: entry.journalId, fiscalYearId: entry.fiscalYearId, number, hash, reversalOfId: entry.reversalOfId, closingEntry: entry.closingEntry },
    },
  })

  // 6. Exécute MAINTENANT le contrôle différé (Prisma avale les erreurs levées au COMMIT).
  await flushDeferredConstraints(tx, ["journal_entries_validation_check_trg"])
  await tx.$executeRaw`SELECT set_config('planificator.accounting_posting', 'off', true)`
  return { id: entry.id, number, hash }
}

type MirrorLine = { accountId: string; debitCents: bigint; creditCents: bigint }
/** Vérifie que `lines` est le miroir exact (multiensemble compte/débit↔crédit) de l'écriture validée `originalId`. */
async function assertMirrorOf(tx: Tx, ctx: AccountingContext, originalId: string, lines: MirrorLine[]): Promise<void> {
  const original = await tx.journalEntry.findFirst({
    where: { id: originalId, companyId: ctx.companyId, status: "VALIDATED" },
    select: { lines: { select: { accountId: true, debitCents: true, creditCents: true } } },
  })
  if (!original) throw new AccountingError("ENTRY_REVERSAL_INVALID", ["ORIGINAL_NOT_VALIDATED"])
  const key = (acc: string, d: bigint, c: bigint) => `${acc}|${d.toString()}|${c.toString()}`
  const expected = original.lines.map((l) => key(l.accountId, l.creditCents, l.debitCents)).sort()
  const actual = lines.map((l) => key(l.accountId, l.debitCents, l.creditCents)).sort()
  if (expected.length !== actual.length || expected.some((k, i) => k !== actual[i])) {
    throw new AccountingError("ENTRY_REVERSAL_INVALID", ["NOT_MIRROR"])
  }
}

/** Contre-passation : miroir exact (débit ↔ crédit) d'une écriture validée, puis validation. */
export async function reverseEntry(tx: Tx, ctx: AccountingContext, entryId: string, entryDate: Date, label?: string): Promise<{ id: string; number: number }> {
  const original = await tx.journalEntry.findFirst({
    where: { id: entryId, companyId: ctx.companyId },
    include: { lines: { orderBy: { position: "asc" } } },
  })
  if (!original) throw new AccountingError("ENTRY_NOT_FOUND")
  if (original.status !== "VALIDATED") throw new AccountingError("ENTRY_NOT_VALIDATED")
  const draft = await createDraftEntry(tx, ctx, {
    journalId: original.journalId,
    fiscalYearId: original.fiscalYearId,
    entryDate,
    documentRef: original.documentRef,
    label: label ?? `Contre-passation de l'écriture n° ${original.number}`,
    reversalOfId: original.id,
    lines: original.lines.map((l) => ({ accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents, label: l.label, vatRateBp: l.vatRateBp })),
  })
  const posted = await postEntry(tx, ctx, draft.id)
  return { id: posted.id, number: posted.number }
}

/** Vérifie la chaîne d'un journal en remontant depuis la tête ; renvoie le nombre d'écritures vérifiées. */
export async function verifyChain(tx: Tx, ctx: AccountingContext, journalId: string): Promise<{ ok: boolean; checked: number; brokenAt?: string }> {
  const head = await tx.accountingChainHead.findUnique({ where: { companyId_journalId: { companyId: ctx.companyId, journalId } } })
  if (!head) return { ok: true, checked: 0 }
  let cursor = head.lastEntryId
  let expected = head.lastHash
  let checked = 0
  while (cursor) {
    const e = await tx.journalEntry.findFirst({ where: { id: cursor, companyId: ctx.companyId }, include: { lines: true } })
    if (!e || e.status !== "VALIDATED" || e.hash !== expected) return { ok: false, checked, brokenAt: cursor }
    const recomputed = entryHash({
      companyId: e.companyId, journalId: e.journalId, fiscalYearId: e.fiscalYearId, number: e.number!, entryDate: e.entryDate,
      documentDate: e.documentDate, documentRef: e.documentRef, label: e.label, validatedAt: e.validatedAt!, validatedById: e.validatedById!,
      sourceType: e.sourceType, sourceId: e.sourceId, sourceVersion: e.sourceVersion, reversalOfId: e.reversalOfId, closingEntry: e.closingEntry,
      lines: e.lines.map((l) => ({ position: l.position, accountId: l.accountId, label: l.label, debitCents: l.debitCents, creditCents: l.creditCents, vatRateBp: l.vatRateBp })),
    }, e.prevHash!)
    if (recomputed !== e.hash) return { ok: false, checked, brokenAt: e.id }
    checked++
    expected = e.prevHash!
    cursor = e.prevEntryId
  }
  return { ok: expected === genesisHash(ctx.companyId, journalId), checked }
}
