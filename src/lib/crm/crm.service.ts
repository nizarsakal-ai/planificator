/**
 * Lot E Planificator V2 : service des opportunités. Toute lecture et écriture est bornée par `ctx.companyId`
 * (session). Chaque écriture ajoute un événement d'historique (OpportunityEvent, append-only) et une ligne `HistoryLog`
 * dans la même transaction. Les modifications verrouillent la ligne (`SELECT … FOR UPDATE`, bornée par companyId) et
 * écrivent sous condition d'une étape encore ouverte ; une opportunité close est figée (garantie aussi en base).
 */
import type { HistoryAction, Prisma, PrismaClient } from "@prisma/client"
import { businessYear } from "@/lib/billing/business-day"
import { serverNow } from "@/lib/billing/clock"
import { formatEuro } from "@/lib/billing/money"
import {
  CRM_ERRORS, STAGE_LABEL, isOpen, planStageChange, validateFields, validateNote,
  type OpportunityFields, type OpportunityStage,
} from "@/lib/crm/crm.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface CrmContext { companyId: string; userId: string }
export type CrmResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

class CrmFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "CrmFailure" }
}
const fail = (m: string): never => { throw new CrmFailure(m) }
function must<T>(p: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!p.ok) fail(p.error)
  return (p as { ok: true; value: T }).value
}
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<CrmResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof CrmFailure) return { ok: false, error: e.userMessage }
    throw e
  }
}
async function audit(tx: Tx, ctx: CrmContext, a: { action: HistoryAction; entityId: string; detail: string; worksiteId?: string | null }) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId: a.worksiteId ?? null, action: a.action, entityType: "Opportunity", entityId: a.entityId, detail: a.detail } })
}
async function event(tx: Tx, ctx: CrmContext, opportunityId: string, e: { type: "CREATED" | "STAGE_CHANGED" | "UPDATED" | "FOLLOW_UP_DONE" | "NOTE"; fromStage?: OpportunityStage; toStage?: OpportunityStage; note?: string | null }) {
  await tx.opportunityEvent.create({ data: { companyId: ctx.companyId, opportunityId, type: e.type, fromStage: e.fromStage ?? null, toStage: e.toStage ?? null, note: e.note ?? null, actorId: ctx.userId } })
}

export interface Links { worksiteId?: string | null; quoteId?: string | null; consultationDraftId?: string | null; ownerEmployeeId?: string | null }

/** Vérifie que chaque lien désigne un objet de l'entreprise de session (et un devis du même client). */
async function checkLinks(tx: Tx, ctx: CrmContext, clientId: string | null, l: Links) {
  const c = ctx.companyId
  if (clientId) (await tx.client.findFirst({ where: { id: clientId, companyId: c }, select: { id: true } })) ?? fail(CRM_ERRORS.notFound)
  if (l.worksiteId) (await tx.worksite.findFirst({ where: { id: l.worksiteId, companyId: c }, select: { id: true } })) ?? fail(CRM_ERRORS.notFound)
  if (l.quoteId) {
    const q = (await tx.quote.findFirst({ where: { id: l.quoteId, companyId: c }, select: { clientId: true } })) ?? fail(CRM_ERRORS.notFound)
    if (clientId && q.clientId !== clientId) fail(CRM_ERRORS.quoteClient)
  }
  if (l.consultationDraftId) (await tx.worksiteImportDraft.findFirst({ where: { id: l.consultationDraftId, companyId: c }, select: { id: true } })) ?? fail(CRM_ERRORS.notFound)
  if (l.ownerEmployeeId) (await tx.employee.findFirst({ where: { id: l.ownerEmployeeId, companyId: c, active: true }, select: { id: true } })) ?? fail(CRM_ERRORS.notFound)
}
const linkData = (l: Links) => ({ worksiteId: l.worksiteId || null, quoteId: l.quoteId || null, consultationDraftId: l.consultationDraftId || null, ownerEmployeeId: l.ownerEmployeeId || null })

async function nextNumber(tx: Tx, companyId: string): Promise<string> {
  const year = businessYear(serverNow())
  const c = await tx.documentCounter.upsert({
    where: { companyId_type_year: { companyId, type: "OPPORTUNITY", year } },
    create: { companyId, type: "OPPORTUNITY", year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })
  return `OPP-${year}-${String(c.lastValue).padStart(4, "0")}`
}

export async function createOpportunity(db: Db, ctx: CrmContext, input: OpportunityFields & Links & { stage?: string }): Promise<CrmResult<{ id: string; number: string }>> {
  const stage = (input.stage && isOpen(input.stage as OpportunityStage) ? input.stage : "LEAD") as OpportunityStage
  const f = validateFields(input, stage)
  if (!f.ok) return f
  return inTx(db, async (tx) => {
    await checkLinks(tx, ctx, f.value.clientId, input)
    const number = await nextNumber(tx, ctx.companyId)
    const o = await tx.opportunity.create({ data: { companyId: ctx.companyId, number, stage, ...f.value, ...linkData(input), createdById: ctx.userId }, select: { id: true } })
    await event(tx, ctx, o.id, { type: "CREATED", toStage: undefined, note: `${STAGE_LABEL[stage]} · ${formatEuro(f.value.amountCents)}` })
    await audit(tx, ctx, { action: "CREATED", entityId: o.id, worksiteId: input.worksiteId || null, detail: `Opportunité ${number} créée : ${f.value.title} (${formatEuro(f.value.amountCents)})` })
    return { id: o.id, number }
  })
}

async function lockOpen(tx: Tx, ctx: CrmContext, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "opportunities" WHERE "id" = ${id} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  if (rows.length !== 1) fail(CRM_ERRORS.notFound)
  const o = (await tx.opportunity.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true, number: true, stage: true, worksiteId: true, clientId: true, probabilityBp: true } })) ?? fail(CRM_ERRORS.notFound)
  if (!isOpen(o.stage)) fail(CRM_ERRORS.closed)
  return o
}

export async function updateOpportunity(db: Db, ctx: CrmContext, id: string, input: OpportunityFields & Links): Promise<CrmResult> {
  return inTx(db, async (tx) => {
    const o = await lockOpen(tx, ctx, id)
    // Revue indépendante : probabilité laissée vide à la modification ⇒ la valeur actuelle est conservée.
    const f = must(validateFields({ ...input, probabilityBp: input.probabilityBp ?? o.probabilityBp }, o.stage))
    await checkLinks(tx, ctx, f.clientId, input)
    await tx.opportunity.update({ where: { id: o.id }, data: { ...f, ...linkData(input) } })
    await event(tx, ctx, o.id, { type: "UPDATED", note: `Montant ${formatEuro(f.amountCents)}, probabilité ${f.probabilityBp / 100} %` })
    await audit(tx, ctx, { action: "UPDATED", entityId: o.id, worksiteId: input.worksiteId || o.worksiteId, detail: `Opportunité ${o.number} modifiée` })
    return undefined
  })
}

export async function changeStage(db: Db, ctx: CrmContext, id: string, to: string, lostReason: string | null, now: Date = serverNow()): Promise<CrmResult<{ stage: OpportunityStage }>> {
  return inTx(db, async (tx) => {
    const o = await lockOpen(tx, ctx, id)
    const p = must(planStageChange(o.stage, to, lostReason, now))
    const u = await tx.opportunity.updateMany({
      where: { id: o.id, companyId: ctx.companyId, stage: o.stage },
      data: { stage: p.stage, closedAt: p.closedAt, lostReason: p.lostReason, ...(p.probabilityBp !== null ? { probabilityBp: p.probabilityBp } : {}), ...(p.closedAt ? { nextFollowUpDate: null } : {}) },
    })
    if (u.count !== 1) fail(CRM_ERRORS.closed)
    await event(tx, ctx, o.id, { type: "STAGE_CHANGED", fromStage: o.stage, toStage: p.stage, note: p.lostReason })
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityId: o.id, worksiteId: o.worksiteId, detail: `Opportunité ${o.number} : ${STAGE_LABEL[o.stage]} → ${STAGE_LABEL[p.stage]}${p.lostReason ? ` (${p.lostReason})` : ""}` })
    return { stage: p.stage }
  })
}

/** Relance faite : note obligatoire ; prochaine date de relance facultative (sinon aucune relance planifiée). */
export async function recordFollowUp(db: Db, ctx: CrmContext, id: string, note: string, nextFollowUpDate: Date | null): Promise<CrmResult> {
  const n = validateNote(note)
  if (!n.ok) return n
  return inTx(db, async (tx) => {
    const o = await lockOpen(tx, ctx, id)
    await tx.opportunity.update({ where: { id: o.id }, data: { nextFollowUpDate, followUpNote: null } })
    await event(tx, ctx, o.id, { type: "FOLLOW_UP_DONE", note: n.value })
    await audit(tx, ctx, { action: "UPDATED", entityId: o.id, worksiteId: o.worksiteId, detail: `Opportunité ${o.number} : relance faite${nextFollowUpDate ? `, prochaine le ${nextFollowUpDate.toISOString().slice(0, 10)}` : ""}` })
    return undefined
  })
}

/** Note libre : admise aussi sur une opportunité close (elle n'en modifie aucun champ). */
export async function addNote(db: Db, ctx: CrmContext, id: string, note: string): Promise<CrmResult> {
  const n = validateNote(note)
  if (!n.ok) return n
  return inTx(db, async (tx) => {
    const o = (await tx.opportunity.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true, worksiteId: true } })) ?? fail(CRM_ERRORS.notFound)
    await event(tx, ctx, o.id, { type: "NOTE", note: n.value })
    await audit(tx, ctx, { action: "UPDATED", entityId: o.id, worksiteId: o.worksiteId, detail: "Note ajoutée à l'opportunité" })
    return undefined
  })
}
