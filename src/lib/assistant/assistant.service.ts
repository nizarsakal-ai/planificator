/**
 * Lot F Planificator V2 : service de l'assistant. Toute lecture et écriture est bornée par `ctx.companyId` (session).
 * Aucun appel réseau, aucun fournisseur externe : les propositions viennent des règles locales (assistant.core.ts).
 *
 * - Génération : sous verrou consultatif de l'entreprise (deux analyses simultanées ne se doublent pas), seules les
 *   observations sans proposition existante (clé de source unique en base) sont proposées ; chacune est journalisée.
 * - Approbation : verrouille la proposition (`FOR UPDATE`), exige l'état « en attente », RELIT la source et revérifie
 *   qu'elle justifie toujours l'action ; sinon la proposition est périmée et rien n'est créé. Sinon la tâche est créée,
 *   la proposition passe « exécutée » avec la tâche, le journal et l'historique sont écrits : tout dans une transaction.
 * - Refus : même verrou, motif facultatif, journalisé. Une décision est définitive (garantie aussi en base).
 * Sources lues (portage sur ab987847) : opportunités du pipeline commercial (lot E) et niveaux de stock (lot A),
 * chacune seulement si son module est activé — à la génération comme à l'approbation (v2 : source désactivée ⇒ refus
 * avant relecture, proposition laissée en attente). Aucune table ni bibliothèque du lot D (réserves) n'est lue.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import { serverNow } from "@/lib/billing/clock"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import {
  ASSISTANT_ERRORS, MAX_FACTS_PER_RULE, RULE_LABEL, holds, isRuleSourceEnabled, proposeFromFacts, readPayload, validateApproval,
  type ApprovalInput, type AssistantRule, type EnabledSources, type Facts, type FollowUpFact, type StockFact,
} from "@/lib/assistant/assistant.core"
import { activeProvider } from "@/lib/assistant/providers"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface AssistantContext { companyId: string; userId: string }
export type AssistantResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }
/** Modules sources activés : une règle ne lit que les données d'un module visible (génération ET approbation). */
export type { EnabledSources }
/** Valeur par défaut des appels sans drapeaux (compatibilité) : les actions serveur transmettent TOUJOURS les drapeaux réels. */
const ALL_SOURCES: EnabledSources = Object.freeze({ crm: true, stock: true })

class AssistantFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "AssistantFailure" }
}
const fail = (m: string): never => { throw new AssistantFailure(m) }
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<AssistantResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof AssistantFailure) return { ok: false, error: e.userMessage }
    throw e
  }
}
async function log(tx: Tx, ctx: AssistantContext, proposalId: string, event: "GENERATED" | "EXECUTED" | "REJECTED" | "OBSOLETE", detail: string) {
  await tx.assistantActionLog.create({ data: { companyId: ctx.companyId, proposalId, event, actorId: ctx.userId, detail: detail.slice(0, 500) } })
}

type Reader = Pick<Tx, "opportunity" | "stockLevel">
const OPEN_STAGES = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION"] as const
const toFollowUp = (o: { id: string; number: string; title: string; stage: string; prospectName: string | null; worksiteId: string | null; nextFollowUpDate: Date | null; client: { name: string } | null }): FollowUpFact | null =>
  o.nextFollowUpDate ? { id: o.id, number: o.number, title: o.title, party: o.client?.name ?? o.prospectName ?? "—", worksiteId: o.worksiteId, nextFollowUpDate: o.nextFollowUpDate, open: (OPEN_STAGES as readonly string[]).includes(o.stage) } : null
const toStock = (s: { id: string; quantityMilli: number; minQuantityMilli: number | null; article: { designation: string; unit: string }; warehouse: { name: string } }): StockFact =>
  ({ id: s.id, articleName: s.article.designation, warehouseName: s.warehouse.name, unit: s.article.unit, quantityMilli: s.quantityMilli, minQuantityMilli: s.minQuantityMilli ?? 0 })
const OPP_SELECT = { id: true, number: true, title: true, stage: true, prospectName: true, worksiteId: true, nextFollowUpDate: true, client: { select: { name: true } } } as const
const STK_SELECT = { id: true, quantityMilli: true, minQuantityMilli: true, article: { select: { designation: true, unit: true } }, warehouse: { select: { name: true } } } as const

/** Faits observés (bornés à 50 par règle), seulement pour les modules sources activés. */
export async function loadFacts(db: Reader, companyId: string, enabled: EnabledSources, today: Date): Promise<Facts> {
  const take = MAX_FACTS_PER_RULE
  // Lectures séquentielles et typées une à une (aucune lecture pour un module source désactivé).
  const ops = enabled.crm ? await db.opportunity.findMany({ where: { companyId, stage: { in: [...OPEN_STAGES] }, nextFollowUpDate: { lt: today } }, orderBy: [{ nextFollowUpDate: "asc" }, { id: "asc" }], take, select: OPP_SELECT }) : []
  // Seuil renseigné et positif ; la comparaison quantité < seuil (deux colonnes) est faite par la règle pure.
  const stk = enabled.stock ? await db.stockLevel.findMany({ where: { companyId, minQuantityMilli: { gt: 0 }, warehouse: { active: true } }, orderBy: [{ quantityMilli: "asc" }, { id: "asc" }], take: 500, select: STK_SELECT }) : []
  return {
    followUps: ops.map(toFollowUp).filter((f): f is FollowUpFact => f !== null),
    stock: stk.map(toStock).filter((f) => holds.stock(f)).slice(0, take),
  }
}

export interface GenerateSummary { proposed: number; alreadyKnown: number }

export async function generateProposals(db: Db, ctx: AssistantContext, enabled: EnabledSources, now: Date = serverNow()): Promise<AssistantResult<GenerateSummary>> {
  const today = parisToday(now)
  const provider = activeProvider()
  return inTx(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`assistant:${ctx.companyId}`}, 0))`
    const drafts = proposeFromFacts(await loadFacts(tx, ctx.companyId, enabled, today), today)
    if (drafts.length === 0) return { proposed: 0, alreadyKnown: 0 }
    const known = new Set((await tx.assistantProposal.findMany({ where: { companyId: ctx.companyId, sourceKey: { in: drafts.map((d) => d.sourceKey) } }, select: { sourceKey: true } })).map((p) => p.sourceKey))
    let proposed = 0
    for (const d of drafts) {
      if (known.has(d.sourceKey)) continue
      const p = await tx.assistantProposal.create({
        data: { companyId: ctx.companyId, sourceKey: d.sourceKey, rule: d.rule, provider: provider.id, title: d.title, rationale: d.rationale, action: "CREATE_TASK", payload: { ...d.payload }, sources: d.sources.map((s) => ({ ...s })), createdById: ctx.userId },
        select: { id: true },
      })
      await log(tx, ctx, p.id, "GENERATED", `${RULE_LABEL[d.rule]} : ${d.title}`)
      proposed++
    }
    return { proposed, alreadyKnown: drafts.length - proposed }
  })
}

async function lockPending(tx: Tx, ctx: AssistantContext, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "assistant_proposals" WHERE "id" = ${id} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  if (rows.length !== 1) fail(ASSISTANT_ERRORS.notFound)
  const p = (await tx.assistantProposal.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true, rule: true, title: true, rationale: true, status: true, payload: true, sources: true } })) ?? fail(ASSISTANT_ERRORS.notFound)
  if (p.status !== "PENDING") fail(ASSISTANT_ERRORS.decided)
  return p
}

/**
 * La source justifie-t-elle toujours l'action ? Relue dans la transaction d'approbation, APRÈS verrouillage de sa ligne
 * (`FOR UPDATE`, borné par companyId) : une modification concurrente de la source attend la fin de l'approbation, ou
 * l'approbation voit la source déjà modifiée (revue indépendante). Règle inconnue ⇒ jamais justifiée.
 */
async function stillHolds(tx: Tx, companyId: string, rule: AssistantRule, sourceId: string, today: Date): Promise<boolean> {
  if (rule === "OPPORTUNITY_FOLLOW_UP_OVERDUE") {
    await tx.$queryRaw`SELECT "id" FROM "opportunities" WHERE "id" = ${sourceId} AND "companyId" = ${companyId} FOR UPDATE`
    const o = await tx.opportunity.findFirst({ where: { id: sourceId, companyId }, select: OPP_SELECT })
    const f = o ? toFollowUp(o) : null
    return !!f && holds.followUp(f, today)
  }
  if (rule === "STOCK_BELOW_MINIMUM") {
    await tx.$queryRaw`SELECT "id" FROM "stock_levels" WHERE "id" = ${sourceId} AND "companyId" = ${companyId} FOR UPDATE`
    // Mêmes conditions qu'à la génération : dépôt actif.
    const s = await tx.stockLevel.findFirst({ where: { id: sourceId, companyId, warehouse: { active: true } }, select: STK_SELECT })
    return !!s && holds.stock(toStock(s))
  }
  return false
}

export type ApproveOutcome = { executed: true; taskId: string } | { executed: false; obsolete: true }

/**
 * Approbation. `enabled` : modules sources activés, même décision qu'à la génération. Si le module source de la règle
 * est désactivé, refus explicite AVANT toute lecture de la source : la transaction est annulée, la proposition reste en
 * attente (ni tâche, ni décision, ni journal) et pourra être approuvée après réactivation du module.
 */
export async function approveProposal(db: Db, ctx: AssistantContext, id: string, input: ApprovalInput, now: Date = serverNow(), enabled: EnabledSources = ALL_SOURCES): Promise<AssistantResult<ApproveOutcome>> {
  const today = parisToday(now)
  return inTx(db, async (tx): Promise<ApproveOutcome> => {
    const p = await lockPending(tx, ctx, id)
    if (!isRuleSourceEnabled(p.rule, enabled)) fail(ASSISTANT_ERRORS.sourceDisabled)
    const payload = readPayload(p.payload) ?? fail(ASSISTANT_ERRORS.notFound)
    const v = validateApproval(payload, input)
    if (!v.ok) fail(v.error)
    const a = (v as Extract<typeof v, { ok: true }>).value
    const sources = Array.isArray(p.sources) ? (p.sources as { id?: unknown }[]) : []
    const sourceId = typeof sources[0]?.id === "string" ? (sources[0].id as string) : ""
    if (!(await stillHolds(tx, ctx.companyId, p.rule as AssistantRule, sourceId, today))) {
      await tx.assistantProposal.update({ where: { id: p.id }, data: { status: "OBSOLETE", decidedById: ctx.userId, decidedAt: now } })
      await log(tx, ctx, p.id, "OBSOLETE", "Approbation demandée, mais la source ne justifie plus l'action : aucune tâche créée")
      return { executed: false, obsolete: true }
    }
    if (a.assigneeId) (await tx.employee.findFirst({ where: { id: a.assigneeId, companyId: ctx.companyId, active: true }, select: { id: true } })) ?? fail(ASSISTANT_ERRORS.assignee)
    const worksiteId = payload.worksiteId && (await tx.worksite.findFirst({ where: { id: payload.worksiteId, companyId: ctx.companyId }, select: { id: true } })) ? payload.worksiteId : null
    const task = await tx.task.create({
      data: {
        companyId: ctx.companyId, title: a.title, priority: payload.priority, dueDate: a.dueDate, assigneeId: a.assigneeId, worksiteId, createdById: ctx.userId,
        description: `${p.rationale}\n\nProposée par l'assistant (règles locales, ${RULE_LABEL[p.rule as AssistantRule] ?? p.rule}) et approuvée le ${formatDay(today)}.`.slice(0, 2000),
      },
      select: { id: true },
    })
    await tx.assistantProposal.update({ where: { id: p.id }, data: { status: "EXECUTED", decidedById: ctx.userId, decidedAt: now, resultEntityType: "Task", resultEntityId: task.id } })
    await log(tx, ctx, p.id, "EXECUTED", `Approuvée : tâche « ${a.title} » créée`)
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId, action: "CREATED", entityType: "Task", entityId: task.id, detail: `Tâche « ${a.title} » créée sur approbation d'une proposition de l'assistant` } })
    return { executed: true, taskId: task.id }
  })
}

export async function rejectProposal(db: Db, ctx: AssistantContext, id: string, note: string | null, now: Date = serverNow()): Promise<AssistantResult> {
  const n = (note ?? "").trim() || null
  if (n && n.length > 500) return { ok: false, error: ASSISTANT_ERRORS.note }
  return inTx(db, async (tx) => {
    const p = await lockPending(tx, ctx, id)
    await tx.assistantProposal.update({ where: { id: p.id }, data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: now, decisionNote: n } })
    await log(tx, ctx, p.id, "REJECTED", n ? `Refusée : ${n}` : "Refusée")
    return undefined
  })
}
