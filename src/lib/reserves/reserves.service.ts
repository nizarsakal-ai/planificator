/**
 * Lot D Planificator V2 : service des réserves et des procès-verbaux de réception. Toute lecture et écriture est
 * bornée par `ctx.companyId` (session). Chaque écriture produit une ligne `HistoryLog` dans la même transaction ; tout
 * échec annule l'ensemble.
 *
 * Concurrence : la création d'une réserve et la signature d'un procès-verbal d'un même chantier sont sérialisées par
 * un verrou consultatif de transaction (`pg_advisory_xact_lock`, clé entreprise + chantier). Le procès-verbal relit
 * donc l'ensemble EXACT des réserves ouvertes ; la base le revérifie à la validation (déclencheur différé). Levée et
 * annulation prennent le MÊME verrou de chantier (revue indépendante : sinon une annulation concurrente d'une signature
 * ne voyait pas le lien encore non validé), puis verrouillent la ligne de la réserve (`SELECT … FOR UPDATE`, bornée par
 * companyId) et écrivent sous condition de l'état lu. Ordre d'acquisition unique partout : chantier, puis ligne.
 * Les chantiers archivés restent admis : la réception et la levée des réserves suivent souvent la fin du chantier.
 *
 * Contrainte différée (correctif D r1, preuves d1) : Prisma 5 AVALE l'erreur levée au COMMIT d'une transaction interactive
 * (src/lib/deferred-constraints.ts) ; la base annule, mais le service aurait répondu « PV signé ». Le contrôle
 * « reception_reports_consistent » (toutes les réserves ouvertes inscrites, au plus 500) est donc évalué DANS la
 * transaction, en dernière instruction, puis remis en différé : une violation devient une erreur rendue à l'utilisateur.
 */
import type { HistoryAction, Prisma, PrismaClient } from "@prisma/client"
import { businessYear } from "@/lib/billing/business-day"
import { serverNow } from "@/lib/billing/clock"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import {
  DECISION_LABEL, MAX_FILES_PER_ACTION, MAX_REPORT_RESERVES, RESERVE_ERRORS, SNAPSHOT_VERSION, documentNumber, parseSignature, planCancel,
  planFile, planLift, planReport, snapshotSha256, sortReserves, validateReserve,
  type ReportInput, type ReportSnapshot, type ReserveInput, type ReserveStatus,
} from "@/lib/reserves/reserves.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface ReserveServiceContext { companyId: string; userId: string }
export type ReserveResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }
export interface UploadedFile { name: string; bytes: Uint8Array }

class ReserveFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "ReserveFailure" }
}
const fail = (m: string): never => { throw new ReserveFailure(m) }
function must<T>(p: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!p.ok) fail(p.error)
  return (p as { ok: true; value: T }).value
}
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<ReserveResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn, { maxWait: 5000, timeout: 20000 }) }
  } catch (e) {
    if (e instanceof ReserveFailure) return { ok: false, error: e.userMessage }
    // Revue indépendante : un refus des déclencheurs de réception (réserves modifiées entre-temps) devient un message utile.
    if (e instanceof Error && /every open reserve|open reserve of the same worksite|listed in a reception report/.test(e.message)) return { ok: false, error: RESERVE_ERRORS.changedMeanwhile }
    if (e instanceof Error && /more than 500 reserves/.test(e.message)) return { ok: false, error: RESERVE_ERRORS.tooManyReserves }
    throw e
  }
}
async function audit(tx: Tx, ctx: ReserveServiceContext, a: { action: HistoryAction; entityType: string; entityId: string; detail: string; worksiteId: string }) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId: a.worksiteId, action: a.action, entityType: a.entityType, entityId: a.entityId, detail: a.detail } })
}
async function nextNumber(tx: Tx, companyId: string, type: "WORKSITE_RESERVE" | "RECEPTION_REPORT", prefix: "RES" | "PV"): Promise<string> {
  const year = businessYear(serverNow())
  const c = await tx.documentCounter.upsert({
    where: { companyId_type_year: { companyId, type, year } },
    create: { companyId, type, year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })
  return documentNumber(prefix, year, c.lastValue)
}
/** Sérialise réserves et procès-verbaux d'un même chantier jusqu'à la fin de la transaction. */
async function lockWorksiteReception(tx: Tx, ctx: ReserveServiceContext, worksiteId: string) {
  const key = `reception:${ctx.companyId}:${worksiteId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}
async function requireWorksite(tx: Tx, ctx: ReserveServiceContext, worksiteId: string) {
  return (await tx.worksite.findFirst({ where: { id: worksiteId, companyId: ctx.companyId }, select: { id: true, name: true, address: true, client: { select: { name: true } } } })) ?? fail(RESERVE_ERRORS.notFound)
}
function planFiles(files: readonly UploadedFile[]) {
  if (files.length > MAX_FILES_PER_ACTION) fail(RESERVE_ERRORS.tooManyFiles)
  return files.map((f) => ({ ...must(planFile(f.name, f.bytes)), data: Buffer.from(f.bytes) }))
}
async function storeFiles(tx: Tx, ctx: ReserveServiceContext, reserveId: string, kind: "FINDING" | "LIFT", files: ReturnType<typeof planFiles>) {
  for (const f of files) {
    await tx.worksiteReserveFile.create({ data: { companyId: ctx.companyId, reserveId, kind, sha256: f.sha256, mime: f.mime, size: f.size, data: f.data, originalName: f.originalName, createdById: ctx.userId } })
  }
}

export interface CreateReserveInput extends ReserveInput { worksiteId: string }

export async function createReserve(db: Db, ctx: ReserveServiceContext, input: CreateReserveInput, files: readonly UploadedFile[] = []): Promise<ReserveResult<{ id: string; number: string }>> {
  const v = validateReserve(input)
  if (!v.ok) return v
  return inTx(db, async (tx) => {
    const planned = planFiles(files)
    const w = await requireWorksite(tx, ctx, input.worksiteId)
    await lockWorksiteReception(tx, ctx, w.id)
    const number = await nextNumber(tx, ctx.companyId, "WORKSITE_RESERVE", "RES")
    const r = await tx.worksiteReserve.create({
      data: { companyId: ctx.companyId, worksiteId: w.id, number, ...v.value, createdById: ctx.userId },
      select: { id: true },
    })
    await storeFiles(tx, ctx, r.id, "FINDING", planned)
    await audit(tx, ctx, { action: "CREATED", entityType: "WorksiteReserve", entityId: r.id, worksiteId: w.id, detail: `Réserve ${number} constatée sur le chantier ${w.name} : ${v.value.title} (${v.value.location})${planned.length ? `, ${planned.length} preuve(s)` : ""}` })
    return { id: r.id, number }
  })
}

async function lockReserve(tx: Tx, ctx: ReserveServiceContext, reserveId: string) {
  const site = (await tx.worksiteReserve.findFirst({ where: { id: reserveId, companyId: ctx.companyId }, select: { worksiteId: true } })) ?? fail(RESERVE_ERRORS.notFound)
  await lockWorksiteReception(tx, ctx, site.worksiteId)
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "worksite_reserves" WHERE "id" = ${reserveId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  if (rows.length !== 1) fail(RESERVE_ERRORS.notFound)
  return (await tx.worksiteReserve.findFirst({ where: { id: reserveId, companyId: ctx.companyId }, select: { id: true, number: true, status: true, worksiteId: true, worksite: { select: { name: true } }, _count: { select: { reports: true } } } })) ?? fail(RESERVE_ERRORS.notFound)
}

/** Levée : note obligatoire, preuves facultatives ; admise aussi pour une réserve inscrite à un procès-verbal. */
export async function liftReserve(db: Db, ctx: ReserveServiceContext, reserveId: string, note: string, files: readonly UploadedFile[] = [], now: Date = serverNow()): Promise<ReserveResult<{ worksiteId: string }>> {
  return inTx(db, async (tx) => {
    const planned = planFiles(files)
    const r = await lockReserve(tx, ctx, reserveId)
    const p = must(planLift(r.status as ReserveStatus, note))
    const u = await tx.worksiteReserve.updateMany({ where: { id: r.id, companyId: ctx.companyId, status: "OPEN" }, data: { status: "LIFTED", liftedAt: now, liftedById: ctx.userId, liftNote: p.note } })
    if (u.count !== 1) fail(RESERVE_ERRORS.notOpen)
    await storeFiles(tx, ctx, r.id, "LIFT", planned)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "WorksiteReserve", entityId: r.id, worksiteId: r.worksiteId, detail: `Réserve ${r.number} levée sur le chantier ${r.worksite.name}${planned.length ? `, ${planned.length} preuve(s)` : ""}` })
    return { worksiteId: r.worksiteId }
  })
}

/** Annulation (erreur de saisie) : motif obligatoire ; refusée si la réserve figure à un procès-verbal. */
export async function cancelReserve(db: Db, ctx: ReserveServiceContext, reserveId: string, reason: string, now: Date = serverNow()): Promise<ReserveResult<{ worksiteId: string }>> {
  return inTx(db, async (tx) => {
    const r = await lockReserve(tx, ctx, reserveId)
    const p = must(planCancel(r.status as ReserveStatus, r._count.reports > 0, reason))
    const u = await tx.worksiteReserve.updateMany({ where: { id: r.id, companyId: ctx.companyId, status: "OPEN" }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: ctx.userId, cancelReason: p.reason } })
    if (u.count !== 1) fail(RESERVE_ERRORS.notOpen)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "WorksiteReserve", entityId: r.id, worksiteId: r.worksiteId, detail: `Réserve ${r.number} annulée (${p.reason})` })
    return { worksiteId: r.worksiteId }
  })
}

export interface CreateReportInput extends ReportInput { worksiteId: string; signatureDataUrl: string }

/**
 * Signature d'un procès-verbal : relit sous verrou TOUTES les réserves ouvertes du chantier, fige l'instantané
 * (canonique, empreinte SHA-256), enregistre la signature du client (PNG vérifié) et inscrit chaque réserve ouverte.
 */
export async function createReceptionReport(db: Db, ctx: ReserveServiceContext, input: CreateReportInput, now: Date = serverNow()): Promise<ReserveResult<{ id: string; number: string }>> {
  const sig = parseSignature(input.signatureDataUrl)
  if (!sig.ok) return sig
  return inTx(db, async (tx) => {
    const w = await requireWorksite(tx, ctx, input.worksiteId)
    await lockWorksiteReception(tx, ctx, w.id)
    // Plafond : compté AVANT toute lecture détaillée ou écriture ; au-delà de MAX_REPORT_RESERVES, refus explicite.
    const openCount = await tx.worksiteReserve.count({ where: { companyId: ctx.companyId, worksiteId: w.id, status: "OPEN" } })
    if (openCount > MAX_REPORT_RESERVES) fail(RESERVE_ERRORS.tooManyReserves)
    // Instantané EXHAUSTIF : aucune limite (`take`) ; le verrou du chantier garantit que l'ensemble lu est complet.
    const open = await tx.worksiteReserve.findMany({
      where: { companyId: ctx.companyId, worksiteId: w.id, status: "OPEN" },
      select: { id: true, number: true, title: true, location: true, severity: true, description: true, dueDate: true, assigneeLabel: true },
    })
    const p = must(planReport(input, open.length, parisToday(now)))
    const company = (await tx.company.findFirst({ where: { id: ctx.companyId }, select: { name: true } })) ?? fail(RESERVE_ERRORS.notFound)
    const number = await nextNumber(tx, ctx.companyId, "RECEPTION_REPORT", "PV")
    const snapshot: ReportSnapshot = {
      version: SNAPSHOT_VERSION, number, company: { name: company.name },
      worksite: { name: w.name, address: w.address ?? null, client: w.client.name },
      decision: p.decision, receptionDate: formatDay(p.receptionDate), signedAt: now.toISOString(),
      clientSignerName: p.clientSignerName, companySignerName: p.companySignerName, attendees: p.attendees, remarks: p.remarks,
      reserves: sortReserves(open.map((r) => ({
        number: r.number, title: r.title, location: r.location, severity: r.severity, description: r.description ?? null,
        dueDate: r.dueDate ? formatDay(r.dueDate) : null, assignee: r.assigneeLabel ?? null,
      }))),
      signatureSha256: sig.value.sha256,
    }
    const report = await tx.receptionReport.create({
      data: {
        companyId: ctx.companyId, worksiteId: w.id, number, decision: p.decision, receptionDate: p.receptionDate,
        clientSignerName: p.clientSignerName, companySignerName: p.companySignerName, attendees: p.attendees, remarks: p.remarks,
        signatureSha256: sig.value.sha256, signaturePng: sig.value.png, snapshot: snapshot as unknown as Prisma.InputJsonValue,
        snapshotSha256: snapshotSha256(snapshot), createdById: ctx.userId,
      },
      select: { id: true },
    })
    if (open.length > 0) await tx.receptionReportReserve.createMany({ data: open.map((r) => ({ companyId: ctx.companyId, reportId: report.id, reserveId: r.id })) })
    await audit(tx, ctx, { action: "CREATED", entityType: "ReceptionReport", entityId: report.id, worksiteId: w.id, detail: `Procès-verbal ${number} signé pour le chantier ${w.name} : ${DECISION_LABEL[p.decision]} (${open.length} réserve(s) ouverte(s))` })
    // Dernière instruction : contrôle différé évalué AVANT le COMMIT (sinon une violation serait silencieusement annulée).
    await flushDeferredConstraints(tx, ["reception_reports_consistent"])
    return { id: report.id, number }
  })
}
