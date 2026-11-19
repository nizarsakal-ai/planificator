// ═══════════════════════════════════════════════════════════════════════════
// SPEC-INVOICE-IMPORT-001 §5 (amendement du 19/11/2026) — changement de statut EN MASSE des pièces importées.
// Seul le statut normalisé change : montants, numéro, client, PDF et `sourceStatus` (libellé d'origine) restent intacts.
// Garanties :
//   - borné à la société de session, à UN lot d'import et au statut de départ (`from`) : relancer ne modifie rien (idempotent) ;
//   - dry-run par défaut côté appelants : liste exacte de ce qui serait modifié, aucune écriture ;
//   - application en une transaction, avec garde `expectedCount` (le lot doit être celui qui a été relu au dry-run) ;
//   - `contentHash` recalculé (un réimport identique reste « déjà importé ») ; une ligne HistoryLog par pièce.
// Aucune écriture dans `invoices`, `invoice_payments`, la comptabilité ou la TVA.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma, PrismaClient } from "@prisma/client"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { contentHash, numberKey } from "./normalize"
import { signedTTCCents, type ImportedTotalsRow } from "./imported-totals"
import type { ImportStatus } from "./types"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface StatusUpdateContext { companyId: string; userId: string }

export const MAX_STATUS_UPDATE_ROWS = 5000

export const STATUS_UPDATE_ERRORS = {
  sameStatus: "Le statut de départ et le statut cible sont identiques.",
  batchNotFound: "Import introuvable.",
  batchNotCommitted: "Cet import n'est pas validé : modifiez le statut dans l'aperçu.",
  tooMany: `Trop de pièces à modifier en une fois (maximum ${MAX_STATUS_UPDATE_ROWS}).`,
  nothing: "Aucune pièce à modifier : le changement a déjà été appliqué.",
  stale: "Les pièces ont changé depuis la vérification : relancez la vérification.",
} as const

export interface StatusChangeRequest { batchId: string; from: ImportStatus; to: ImportStatus }

export interface StatusChangeItem {
  id: string; number: string; kind: "INVOICE" | "CREDIT_NOTE"; clientName: string; issueDate: string
  /** TTC signé (+ facture, − avoir), en centimes. */
  signedTTCCents: bigint
}

export interface StatusChangePlan {
  batchId: string; from: ImportStatus; to: ImportStatus
  items: StatusChangeItem[]
  invoiceCount: number; creditNoteCount: number
  invoicesTTCCents: bigint; creditNotesTTCCents: bigint; netTTCCents: bigint
}

const day = (d: Date): string => d.toISOString().slice(0, 10)

async function loadCandidates(db: Db | Tx, ctx: StatusUpdateContext, req: StatusChangeRequest) {
  return db.importedInvoice.findMany({
    where: { companyId: ctx.companyId, batchId: req.batchId, status: req.from },
    orderBy: [{ issueDate: "asc" }, { number: "asc" }],
    take: MAX_STATUS_UPDATE_ROWS + 1,
    select: {
      id: true, kind: true, number: true, numberKey: true, clientId: true, issueDate: true, dueDate: true,
      totalHTCents: true, vatCents: true, totalTTCCents: true, creditedNumber: true, client: { select: { name: true } },
    },
  })
}
type Candidate = Awaited<ReturnType<typeof loadCandidates>>[number]

function toPlan(req: StatusChangeRequest, rows: Candidate[]): StatusChangePlan {
  const items = rows.map((r): StatusChangeItem => ({ id: r.id, number: r.number, kind: r.kind, clientName: r.client.name, issueDate: day(r.issueDate), signedTTCCents: signedTTCCents(r) }))
  const zero = BigInt(0)
  const inv = items.filter((i) => i.kind === "INVOICE"), cn = items.filter((i) => i.kind === "CREDIT_NOTE")
  const invoicesTTCCents = inv.reduce((s, i) => s + i.signedTTCCents, zero)
  const creditNotesTTCCents = cn.reduce((s, i) => s + i.signedTTCCents, zero)
  return { batchId: req.batchId, from: req.from, to: req.to, items, invoiceCount: inv.length, creditNoteCount: cn.length, invoicesTTCCents, creditNotesTTCCents, netTTCCents: invoicesTTCCents + creditNotesTTCCents }
}

/** Empreinte de contenu recalculée avec le nouveau statut — même formule que `rowContentHash` à l'import. */
export function hashWithStatus(r: Pick<Candidate, "kind" | "numberKey" | "clientId" | "issueDate" | "dueDate" | "totalHTCents" | "vatCents" | "totalTTCCents" | "creditedNumber">, status: ImportStatus): string {
  return contentHash({
    kind: r.kind, numberKey: r.numberKey, clientId: r.clientId, issueDate: day(r.issueDate), dueDate: r.dueDate ? day(r.dueDate) : null,
    htCents: r.totalHTCents.toString(), vatCents: r.vatCents.toString(), ttcCents: r.totalTTCCents.toString(), status,
    creditedNumberKey: r.creditedNumber ? numberKey(r.creditedNumber) : null,
  })
}

async function checkBatch(db: Db | Tx, ctx: StatusUpdateContext, req: StatusChangeRequest): Promise<LifecycleResult> {
  if (req.from === req.to) return { ok: false, error: STATUS_UPDATE_ERRORS.sameStatus }
  const batch = await db.invoiceImportBatch.findFirst({ where: { id: req.batchId, companyId: ctx.companyId }, select: { status: true } })
  if (!batch) return { ok: false, error: STATUS_UPDATE_ERRORS.batchNotFound }
  if (batch.status !== "COMMITTED") return { ok: false, error: STATUS_UPDATE_ERRORS.batchNotCommitted }
  return { ok: true, value: undefined }
}

/** Dry-run : ce qui serait modifié, sans aucune écriture. Un plan vide signifie « déjà appliqué ». */
export async function planImportedStatusChange(db: Db, ctx: StatusUpdateContext, req: StatusChangeRequest): Promise<LifecycleResult<StatusChangePlan>> {
  const ok = await checkBatch(db, ctx, req)
  if (!ok.ok) return ok
  const rows = await loadCandidates(db, ctx, req)
  if (rows.length > MAX_STATUS_UPDATE_ROWS) return { ok: false, error: STATUS_UPDATE_ERRORS.tooMany }
  return { ok: true, value: toPlan(req, rows) }
}

/**
 * Application : transaction unique. `expectedCount` = nombre de pièces vues au dry-run ; tout écart (pièce ajoutée, déjà modifiée
 * par un autre utilisateur) annule l'ensemble. Chaque mise à jour est conditionnée au statut de départ (aucune course perdue en silence).
 */
export async function applyImportedStatusChange(db: Db, ctx: StatusUpdateContext, req: StatusChangeRequest & { expectedCount: number }): Promise<LifecycleResult<StatusChangePlan>> {
  if (!Number.isInteger(req.expectedCount) || req.expectedCount < 0) return { ok: false, error: STATUS_UPDATE_ERRORS.stale }
  return db.$transaction(async (tx): Promise<LifecycleResult<StatusChangePlan>> => {
    const ok = await checkBatch(tx, ctx, req)
    if (!ok.ok) return ok
    const rows = await loadCandidates(tx, ctx, req)
    if (rows.length > MAX_STATUS_UPDATE_ROWS) return { ok: false, error: STATUS_UPDATE_ERRORS.tooMany }
    if (rows.length === 0) return { ok: false, error: STATUS_UPDATE_ERRORS.nothing }
    if (rows.length !== req.expectedCount) return { ok: false, error: STATUS_UPDATE_ERRORS.stale }
    for (const r of rows) {
      const u = await tx.importedInvoice.updateMany({
        where: { id: r.id, companyId: ctx.companyId, batchId: req.batchId, status: req.from },
        data: { status: req.to, contentHash: hashWithStatus(r, req.to), updatedById: ctx.userId },
      })
      if (u.count !== 1) throw new StaleStatusError()
    }
    await tx.historyLog.createMany({
      data: rows.map((r) => ({
        companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED" as const, entityType: "ImportedInvoice", entityId: r.id,
        detail: `${r.kind === "CREDIT_NOTE" ? "Avoir" : "Facture"} importé(e) ${r.number} : statut ${req.from} → ${req.to} (changement en masse, lot ${req.batchId})`,
        oldValue: { status: req.from }, newValue: { status: req.to },
      })),
    })
    return { ok: true, value: toPlan(req, rows) }
  }, { timeout: 60_000, maxWait: 10_000 }).catch((e: unknown) => {
    if (e instanceof StaleStatusError) return { ok: false as const, error: STATUS_UPDATE_ERRORS.stale }
    throw e
  })
}

class StaleStatusError extends Error {
  constructor() { super("stale"); this.name = "StaleStatusError" }
}

/**
 * Lignes agrégées pour les cartes /factures : sommes par (nature, statut) calculées en base, sans charger chaque pièce.
 * Les factures ISSUED dont l'échéance est dépassée sont agrégées à part (échéance fixée à la veille de `today`) pour que
 * `computeImportedTotals` les classe « en retard » ; le reste des ISSUED reçoit une échéance nulle (jamais en retard).
 * Le résultat de `computeImportedTotals` sur ces lignes est identique à celui obtenu pièce par pièce.
 */
export async function loadImportedTotalsRows(db: Db, companyId: string, today: Date): Promise<ImportedTotalsRow[]> {
  const [byStatus, lateIssued] = await Promise.all([
    db.importedInvoice.groupBy({ by: ["kind", "status"], where: { companyId }, _sum: { totalTTCCents: true }, _count: { _all: true } }),
    db.importedInvoice.groupBy({ by: ["kind"], where: { companyId, kind: "INVOICE", status: "ISSUED", dueDate: { lt: today } }, _sum: { totalTTCCents: true }, _count: { _all: true } }),
  ])
  const late = lateIssued[0]
  const lateCount = late?._count._all ?? 0
  const lateSum = late?._sum.totalTTCCents ?? BigInt(0)
  const yesterday = new Date(today.getTime() - 86_400_000)
  const rows: ImportedTotalsRow[] = []
  for (const g of byStatus) {
    let count = g._count._all, sum = g._sum.totalTTCCents ?? BigInt(0)
    if (g.kind === "INVOICE" && g.status === "ISSUED" && lateCount > 0) {
      rows.push({ kind: "INVOICE", status: "ISSUED", totalTTCCents: lateSum, dueDate: yesterday, count: lateCount })
      count -= lateCount; sum -= lateSum
    }
    if (count > 0) rows.push({ kind: g.kind, status: g.status, totalTTCCents: sum, dueDate: null, count })
  }
  return rows
}

/** Lots validés contenant des pièces au statut `status` (proposés pour le changement en masse). */
export async function listBatchesWithStatus(db: Db, companyId: string, status: ImportStatus) {
  const groups = await db.importedInvoice.groupBy({ by: ["batchId"], where: { companyId, status }, _count: { _all: true } })
  if (groups.length === 0) return []
  const batches = await db.invoiceImportBatch.findMany({
    where: { companyId, id: { in: groups.map((g) => g.batchId) }, status: "COMMITTED" },
    orderBy: { committedAt: "desc" },
    select: { id: true, sourceSystem: true, sourceLabel: true, committedAt: true },
  })
  const count = new Map(groups.map((g) => [g.batchId, g._count._all]))
  return batches.map((b) => ({ id: b.id, source: b.sourceLabel ?? b.sourceSystem, committedAt: b.committedAt, count: count.get(b.id) ?? 0 }))
}
