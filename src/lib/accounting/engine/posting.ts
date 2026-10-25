// Service transactionnel du moteur comptable (SPEC-ACC-A ; A1-b).
// Toutes les fonctions reçoivent le client de transaction Prisma et le contexte autorisé
// (société + utilisateur issus de requireAccountingAdmin) ; elles ne lisent jamais d'entrée société client.
import { Prisma } from "@prisma/client"
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
 * Protection contre une révocation concurrente. Les lignes d'autorité (utilisateur, ses fiches salarié,
 * sociétés concernées) sont verrouillées FOR SHARE jusqu'à la fin de la transaction, PUIS relues :
 * - une révocation validée avant le verrou est vue (READ COMMITTED relit la dernière version) ;
 * - une révocation lancée après attend la fin de l'opération comptable (sérialisation).
 * Même règle que la session (resolveCompanyAccess), sans repli silencieux vers une autre société.
 * Ordre des verrous : users → employees → companies → (exercice → écriture → compteur → tête).
 */
export async function assertStillAccountingAdmin(tx: Tx, ctx: AccountingContext): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${ctx.userId} FOR SHARE`
  await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "userId" = ${ctx.userId} ORDER BY "id" FOR SHARE`
  const read = () => tx.user.findUnique({
    where: { id: ctx.userId },
    select: {
      role: true, active: true, companyId: true,
      company: { select: { active: true } },
      employeeProfiles: { select: { companyId: true, active: true, role: true, company: { select: { active: true } } } },
    },
  })
  const first = await read()
  if (!first || !first.active) throw new AccountingError("ACCESS_REVOKED")
  const companyIds = [...new Set([ctx.companyId, first.companyId, ...first.employeeProfiles.map((p) => p.companyId)].filter((c): c is string => !!c))].sort()
  await tx.$queryRaw`SELECT 1 FROM "companies" WHERE "id" IN (${Prisma.join(companyIds)}) ORDER BY "id" FOR SHARE`
  const user = await read()
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
    // Sérialise les créations concurrentes de la même clé source : la seconde attend la première puis
    // relit (READ COMMITTED) et renvoie l'existante ou SOURCE_CONFLICT, jamais une erreur d'unicité.
    const sourceKey = canonicalJson([ctx.companyId, input.source.type, input.source.id, input.source.version])
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('accounting-source'), hashtext(${sourceKey}))`
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
 * Valide une écriture. Contrôles applicatifs (erreurs typées) puis appel de la fonction SQL
 * accounting_post_entry (SECURITY DEFINER), seul chemin autorisé à numéroter, chaîner, auditer et passer
 * l'écriture à VALIDATED ; la base revérifie numéro, chaînage, empreinte et contrôles différés.
 * Idempotent : une écriture déjà validée est renvoyée telle quelle.
 */
export async function postEntry(tx: Tx, ctx: AccountingContext, entryId: string): Promise<{ id: string; number: number; hash: string }> {
  // 0. Lignes d'autorité verrouillées jusqu'au COMMIT : une révocation concurrente attend ou est vue.
  await assertStillAccountingAdmin(tx, ctx)
  const head = await tx.journalEntry.findFirst({
    where: { id: entryId, companyId: ctx.companyId },
    select: { fiscalYearId: true },
  })
  if (!head) throw new AccountingError("ENTRY_NOT_FOUND")

  // 1. Verrous exercice → écriture (même ordre que la fonction SQL, qui les reprend sans attente).
  //    FOR NO KEY UPDATE : compatible avec les FOR KEY SHARE des FK, exclusif entre validations et avec la clôture.
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
  if (entry.sourceType !== null) {
    // Politique A1 : un brouillon sourcé ne doit pas avoir divergé de l'empreinte enregistrée à sa création.
    const current = sourcePayloadHash({
      journalId: entry.journalId, fiscalYearId: entry.fiscalYearId, entryDate: entry.entryDate, documentDate: entry.documentDate,
      documentRef: entry.documentRef, label: entry.label, closingEntry: entry.closingEntry, reversalOfId: entry.reversalOfId,
      lines: entry.lines.map((l) => ({ accountId: l.accountId, label: l.label, debitCents: l.debitCents, creditCents: l.creditCents, vatRateBp: l.vatRateBp })),
    })
    if (current !== entry.sourceHash) throw new AccountingError("SOURCE_HASH_MISMATCH")
  }

  // 2. Numérotation, chaînage, empreinte, audit et contrôles différés : en base, sous le propriétaire des tables.
  const rows = await tx.$queryRaw<{ entry_id: string; entry_number: number; entry_hash: string }[]>`
    SELECT * FROM accounting_post_entry(${ctx.companyId}, ${entry.id}, ${ctx.userId})`
  if (rows.length !== 1) throw new AccountingError("ENTRY_CONFLICT")
  return { id: rows[0].entry_id, number: Number(rows[0].entry_number), hash: rows[0].entry_hash }
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
export interface ReverseOptions {
  entryDate: Date
  /** Exercice de la contre-passation ; par défaut celui de l'écriture d'origine. Après clôture : l'exercice suivant. */
  fiscalYearId?: string
  label?: string
}

export async function reverseEntry(tx: Tx, ctx: AccountingContext, entryId: string, options: ReverseOptions): Promise<{ id: string; number: number }> {
  const { entryDate, label } = options
  const original = await tx.journalEntry.findFirst({
    where: { id: entryId, companyId: ctx.companyId },
    include: { lines: { orderBy: { position: "asc" } } },
  })
  if (!original) throw new AccountingError("ENTRY_NOT_FOUND")
  if (original.status !== "VALIDATED") throw new AccountingError("ENTRY_NOT_VALIDATED")
  const draft = await createDraftEntry(tx, ctx, {
    journalId: original.journalId,
    fiscalYearId: options.fiscalYearId ?? original.fiscalYearId,
    entryDate,
    documentRef: original.documentRef,
    label: label ?? `Contre-passation de l'écriture n° ${original.number}`,
    reversalOfId: original.id,
    lines: original.lines.map((l) => ({ accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents, label: l.label, vatRateBp: l.vatRateBp })),
  })
  const posted = await postEntry(tx, ctx, draft.id)
  return { id: posted.id, number: posted.number }
}

export interface ChainReport {
  ok: boolean
  checked: number
  brokenAt?: string
  reason?: "HEAD_MISSING" | "ENTRY_MISSING" | "HASH_MISMATCH" | "LINK_MISMATCH" | "CYCLE" | "GENESIS_MISMATCH" | "UNREACHABLE_ENTRIES" | "NUMBERING_GAP"
}

/**
 * Vérifie exhaustivement la chaîne d'un journal : remontée depuis la tête avec recalcul de chaque empreinte,
 * détection de cycle, arrivée au genesis, toutes les écritures validées du journal atteintes, numérotation
 * 1..n sans trou par exercice.
 */
export async function verifyChain(tx: Tx, ctx: AccountingContext, journalId: string): Promise<ChainReport> {
  const validated = await tx.journalEntry.findMany({
    where: { companyId: ctx.companyId, journalId, status: "VALIDATED" },
    select: { id: true, fiscalYearId: true, number: true },
  })
  const head = await tx.accountingChainHead.findUnique({ where: { companyId_journalId: { companyId: ctx.companyId, journalId } } })
  if (!head) return validated.length === 0 ? { ok: true, checked: 0 } : { ok: false, checked: 0, reason: "HEAD_MISSING" }
  const visited = new Set<string>()
  let cursor = head.lastEntryId
  let expected = head.lastHash
  while (cursor) {
    if (visited.has(cursor)) return { ok: false, checked: visited.size, brokenAt: cursor, reason: "CYCLE" }
    const e = await tx.journalEntry.findFirst({ where: { id: cursor, companyId: ctx.companyId, journalId }, include: { lines: true } })
    if (!e || e.status !== "VALIDATED") return { ok: false, checked: visited.size, brokenAt: cursor, reason: "ENTRY_MISSING" }
    if (e.hash !== expected) return { ok: false, checked: visited.size, brokenAt: cursor, reason: "LINK_MISMATCH" }
    const recomputed = entryHash({
      companyId: e.companyId, journalId: e.journalId, fiscalYearId: e.fiscalYearId, number: e.number!, entryDate: e.entryDate,
      documentDate: e.documentDate, documentRef: e.documentRef, label: e.label, validatedAt: e.validatedAt!, validatedById: e.validatedById!,
      sourceType: e.sourceType, sourceId: e.sourceId, sourceVersion: e.sourceVersion, reversalOfId: e.reversalOfId, closingEntry: e.closingEntry,
      lines: e.lines.map((l) => ({ position: l.position, accountId: l.accountId, label: l.label, debitCents: l.debitCents, creditCents: l.creditCents, vatRateBp: l.vatRateBp })),
    }, e.prevHash!)
    if (recomputed !== e.hash) return { ok: false, checked: visited.size, brokenAt: e.id, reason: "HASH_MISMATCH" }
    visited.add(e.id)
    expected = e.prevHash!
    cursor = e.prevEntryId
  }
  if (expected !== genesisHash(ctx.companyId, journalId)) return { ok: false, checked: visited.size, reason: "GENESIS_MISMATCH" }
  if (visited.size !== validated.length || validated.some((v) => !visited.has(v.id))) {
    return { ok: false, checked: visited.size, reason: "UNREACHABLE_ENTRIES" }
  }
  const byYear = new Map<string, number[]>()
  for (const v of validated) byYear.set(v.fiscalYearId, [...(byYear.get(v.fiscalYearId) ?? []), v.number!])
  for (const nums of byYear.values()) {
    nums.sort((a, b) => a - b)
    if (nums.some((n, i) => n !== i + 1)) return { ok: false, checked: visited.size, reason: "NUMBERING_GAP" }
  }
  return { ok: true, checked: visited.size }
}
