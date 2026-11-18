/**
 * Lot E Planificator V2 : service et exécuteur des automatisations. Toute lecture et écriture est bornée par
 * `companyId`. Aucune fonction de ce fichier n'envoie de courrier électronique ni n'appelle le réseau : les seules
 * actions sont une tâche interne (Task) ou des notifications internes (Notification) aux administrateurs.
 *
 * Exactement une fois par événement et par règle : pour chaque occurrence candidate, UNE transaction (1) verrouille la
 * règle en partage (`FOR SHARE`) et revérifie qu'elle est ACTIVE, (2) exécute l'action, (3) inscrit l'exécution au
 * journal avec sa clé d'événement, unique par règle en base. Si la clé existe déjà (exécuteur concurrent, reprise), la
 * transaction est annulée avec son action : rien n'est fait deux fois. Une erreur passagère annule tout et l'occurrence
 * est reprise au passage suivant. Une action impossible par configuration (responsable inactif) est journalisée
 * « ignorée » et n'est pas rejouée.
 * Désactivation immédiate : elle verrouille la règle en exclusif (`FOR UPDATE`) ; une exécution en cours se termine
 * avant, toute exécution suivante voit la règle désactivée (et la base refuse le journal d'une règle inactive). Une
 * réapprobation intercalée pendant une passe change `activatedAt` : les occurrences déjà sélectionnées sont abandonnées.
 * Idempotence : la clé unique en base porte sur (société, règle, clé d'événement).
 * Drapeaux : sans pipeline commercial (CRM_OPPORTUNITIES_ENABLED), les règles à déclencheur d'opportunité ne sont ni
 * créées, ni approuvées, ni exécutées (aucune lecture des opportunités, aucun journal : elles attendent).
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { serverNow } from "@/lib/billing/clock"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import { STAGES, STAGE_LABEL } from "@/lib/crm/crm.core"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"
import {
  AUTOMATION_ERRORS, MAX_EVENTS_PER_RULE_RUN, TRIGGER_LABEL, availableTriggers, eventKeys, isTriggerAvailable, renderTemplate, sameActivation, taskDueDate, validateRule,
  type AutomationTrigger, type RuleInput, type TemplateVars,
} from "@/lib/automation/automation.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface AutomationContext { companyId: string; userId: string }
export type AutomationResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

class AutomationFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "AutomationFailure" }
}
const fail = (m: string): never => { throw new AutomationFailure(m) }
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<AutomationResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof AutomationFailure) return { ok: false, error: e.userMessage }
    throw e
  }
}
async function audit(tx: Tx, ctx: AutomationContext, action: "CREATED" | "STATUS_CHANGED", entityId: string, detail: string) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action, entityType: "AutomationRule", entityId, detail } })
}

// ── Règles ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function createRule(db: Db, ctx: AutomationContext, input: RuleInput, crmEnabled: boolean = isCrmEnabled()): Promise<AutomationResult<{ id: string }>> {
  const v = validateRule(input, STAGES)
  if (!v.ok) return v
  if (!isTriggerAvailable(v.value.trigger, crmEnabled)) return { ok: false, error: AUTOMATION_ERRORS.triggerUnavailable }
  return inTx(db, async (tx) => {
    if (v.value.taskAssigneeId) (await tx.employee.findFirst({ where: { id: v.value.taskAssigneeId, companyId: ctx.companyId, active: true }, select: { id: true } })) ?? fail(AUTOMATION_ERRORS.notFound)
    const r = await tx.automationRule.create({
      data: { companyId: ctx.companyId, ...v.value, stageFilter: (v.value.stageFilter as Prisma.AutomationRuleUncheckedCreateInput["stageFilter"]) ?? null, createdById: ctx.userId },
      select: { id: true },
    })
    await audit(tx, ctx, "CREATED", r.id, `Règle d'automatisation « ${v.value.name} » créée en brouillon (${TRIGGER_LABEL[v.value.trigger]})`)
    return { id: r.id }
  })
}

async function lockRule(tx: Tx, ctx: AutomationContext, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "automation_rules" WHERE "id" = ${id} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  if (rows.length !== 1) fail(AUTOMATION_ERRORS.notFound)
  return (await tx.automationRule.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true, name: true, status: true, trigger: true } })) ?? fail(AUTOMATION_ERRORS.notFound)
}

/** Approbation explicite : active une règle en brouillon ou désactivée. Portée à l'activation : `ACTIVATION_SCOPE` (relance due : arriéré inclus). */
export async function approveAndActivate(db: Db, ctx: AutomationContext, id: string, at?: Date, crmEnabled: boolean = isCrmEnabled()): Promise<AutomationResult> {
  return inTx(db, async (tx) => {
    const r = await lockRule(tx, ctx, id)
    // Revue Codex v1 (réserve) : horodatage d'activation pris APRÈS l'obtention du verrou (borne des déclencheurs datés).
    const now = at ?? serverNow()
    if (r.status !== "DRAFT" && r.status !== "DISABLED") fail(AUTOMATION_ERRORS.notDraftOrDisabled)
    if (!isTriggerAvailable(r.trigger, crmEnabled)) fail(AUTOMATION_ERRORS.triggerUnavailable)
    await tx.automationRule.update({ where: { id: r.id }, data: { status: "ACTIVE", approvedById: ctx.userId, approvedAt: now, activatedAt: now, disabledAt: null } })
    await audit(tx, ctx, "STATUS_CHANGED", r.id, `Règle « ${r.name} » approuvée et activée`)
    return undefined
  })
}

export async function disableRule(db: Db, ctx: AutomationContext, id: string, now: Date = serverNow()): Promise<AutomationResult> {
  return inTx(db, async (tx) => {
    const r = await lockRule(tx, ctx, id)
    if (r.status !== "ACTIVE") fail(AUTOMATION_ERRORS.notActive)
    // L'approbation est retirée : une réactivation exige une NOUVELLE approbation (la base le garantit par CHECK).
    await tx.automationRule.update({ where: { id: r.id }, data: { status: "DISABLED", disabledAt: now, approvedById: null, approvedAt: null } })
    await audit(tx, ctx, "STATUS_CHANGED", r.id, `Règle « ${r.name} » désactivée`)
    return undefined
  })
}

// ── Exécuteur ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Occurrence { eventKey: string; vars: TemplateVars; worksiteId: string | null; link: string }
type ActiveRule = Prisma.AutomationRuleGetPayload<{ select: { id: true; companyId: true; name: true; trigger: true; stageFilter: true; action: true; taskTitle: true; taskAssigneeId: true; taskDueInDays: true; message: true; approvedById: true; activatedAt: true } }>

/**
 * Occurrences candidates d'une règle, au plus `MAX_EVENTS_PER_RULE_RUN` NON JOURNALISÉES par passe (revue Codex v1, B1) :
 * les candidats sont lus par lots successifs (pagination par curseur, ordre stable) et les occurrences déjà journalisées
 * sont exclues AVANT d'appliquer la limite ; une passe avance donc toujours tant qu'il reste une occurrence à traiter.
 */
const BATCH = 200
async function candidateBatch(db: Db, rule: ActiveRule, today: Date, cursor: string | null): Promise<{ list: Occurrence[]; next: string | null }> {
  const companyId = rule.companyId
  const since = rule.activatedAt ?? new Date(0)
  const page = { take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }
  const t = rule.trigger as AutomationTrigger
  if (t === "OPPORTUNITY_STAGE_CHANGED") {
    const evs = await db.opportunityEvent.findMany({
      where: { companyId, type: "STAGE_CHANGED", createdAt: { gte: since }, ...(rule.stageFilter ? { toStage: rule.stageFilter } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], ...page,
      select: { id: true, toStage: true, createdAt: true, opportunity: { select: { id: true, number: true, title: true, worksiteId: true, prospectName: true, client: { select: { name: true } }, worksite: { select: { name: true } } } } },
    })
    return {
      next: evs.length === BATCH ? evs[evs.length - 1].id : null,
      list: evs.map((e) => ({ eventKey: eventKeys.stageChanged(e.id), worksiteId: e.opportunity.worksiteId, link: `/crm/opportunites/${e.opportunity.id}`,
        vars: { numero: e.opportunity.number, titre: e.opportunity.title, client: e.opportunity.client?.name ?? e.opportunity.prospectName, chantier: e.opportunity.worksite?.name ?? null, etape: e.toStage ? STAGE_LABEL[e.toStage] : null, date: formatDay(e.createdAt) } })),
    }
  }
  if (t === "OPPORTUNITY_FOLLOW_UP_DUE") {
    // Volontairement SANS borne `activatedAt` (ACTIVATION_SCOPE) : l'arriéré de relances échues est traité une fois.
    const ops = await db.opportunity.findMany({
      where: { companyId, stage: { in: ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION"] }, nextFollowUpDate: { lte: today } },
      orderBy: [{ nextFollowUpDate: "asc" }, { id: "asc" }], ...page,
      select: { id: true, number: true, title: true, stage: true, worksiteId: true, prospectName: true, nextFollowUpDate: true, client: { select: { name: true } }, worksite: { select: { name: true } } },
    })
    return {
      next: ops.length === BATCH ? ops[ops.length - 1].id : null,
      list: ops.map((o) => ({ eventKey: eventKeys.followUpDue(o.id, formatDay(o.nextFollowUpDate!)), worksiteId: o.worksiteId, link: `/crm/opportunites/${o.id}`,
        vars: { numero: o.number, titre: o.title, client: o.client?.name ?? o.prospectName, chantier: o.worksite?.name ?? null, etape: STAGE_LABEL[o.stage], date: formatDay(o.nextFollowUpDate!) } })),
    }
  }
  if (t === "QUOTE_ACCEPTED") {
    const qs = await db.quote.findMany({
      where: { companyId, status: { in: ["ACCEPTED", "CONVERTED"] }, acceptedAt: { gte: since } },
      orderBy: [{ acceptedAt: "asc" }, { id: "asc" }], ...page,
      select: { id: true, number: true, subject: true, acceptedAt: true, worksiteId: true, client: { select: { name: true } }, worksite: { select: { name: true } } },
    })
    return {
      next: qs.length === BATCH ? qs[qs.length - 1].id : null,
      list: qs.map((q) => ({ eventKey: eventKeys.quoteAccepted(q.id, q.acceptedAt!), worksiteId: q.worksiteId, link: `/devis/${q.id}`,
        vars: { numero: q.number, titre: q.subject, client: q.client.name, chantier: q.worksite.name, etape: "Accepté", date: formatDay(q.acceptedAt!) } })),
    }
  }
  return { list: [], next: null }
}

async function occurrences(db: Db, rule: ActiveRule, today: Date): Promise<Occurrence[]> {
  const pending: Occurrence[] = []
  let cursor: string | null = null
  do {
    const batch: { list: Occurrence[]; next: string | null } = await candidateBatch(db, rule, today, cursor)
    if (batch.list.length > 0) {
      const done = new Set((await db.automationRun.findMany({ where: { companyId: rule.companyId, ruleId: rule.id, eventKey: { in: batch.list.map((o) => o.eventKey) } }, select: { eventKey: true } })).map((r) => r.eventKey))
      for (const o of batch.list) if (!done.has(o.eventKey) && pending.length < MAX_EVENTS_PER_RULE_RUN) pending.push(o)
    }
    cursor = batch.next
  } while (cursor !== null && pending.length < MAX_EVENTS_PER_RULE_RUN)
  return pending
}

export interface RunSummary { rules: number; done: number; skipped: number; duplicates: number; errors: number }

/** Une occurrence : verrou partagé de la règle, action, journal — tout ou rien. */
async function runOne(db: Db, rule: ActiveRule, occ: Occurrence, today: Date): Promise<"done" | "skipped" | "duplicate" | "inactive"> {
  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string; activatedAt: Date | null }[]>`SELECT "status"::text AS "status", "activatedAt" FROM "automation_rules" WHERE "id" = ${rule.id} AND "companyId" = ${rule.companyId} FOR SHARE`
      if (locked.length !== 1 || !sameActivation(locked[0], rule)) return "inactive" as const
      const base = { companyId: rule.companyId, ruleId: rule.id, eventKey: occ.eventKey }
      if (rule.action === "CREATE_TASK") {
        if (rule.taskAssigneeId && !(await tx.employee.findFirst({ where: { id: rule.taskAssigneeId, companyId: rule.companyId, active: true }, select: { id: true } }))) {
          await tx.automationRun.create({ data: { ...base, status: "SKIPPED", detail: AUTOMATION_ERRORS.assigneeInactive } })
          return "skipped" as const
        }
        const task = await tx.task.create({
          data: {
            companyId: rule.companyId, title: renderTemplate(rule.taskTitle ?? "", occ.vars, 200),
            description: `Tâche créée par l'automatisation « ${rule.name} » (${TRIGGER_LABEL[rule.trigger as AutomationTrigger]}).`,
            assigneeId: rule.taskAssigneeId, worksiteId: occ.worksiteId, dueDate: taskDueDate(today, rule.taskDueInDays),
            createdById: rule.approvedById ?? "automation",
          },
          select: { id: true },
        })
        await tx.automationRun.create({ data: { ...base, status: "DONE", detail: `Tâche créée : ${renderTemplate(rule.taskTitle ?? "", occ.vars, 200)}`.slice(0, 500), taskId: task.id } })
        return "done" as const
      }
      // Notification interne des administrateurs actifs de l'entreprise (fiche salarié ADMIN ou SUPER_ADMIN).
      const admins = await tx.employee.findMany({ where: { companyId: rule.companyId, active: true, role: { in: ["ADMIN", "SUPER_ADMIN"] } }, select: { userId: true } })
      const userIds = [...new Set(admins.map((a) => a.userId))]
      const message = renderTemplate(rule.message ?? "", occ.vars, 500)
      if (userIds.length > 0) {
        await tx.notification.createMany({ data: userIds.map((userId) => ({ userId, companyId: rule.companyId, type: "AUTOMATION" as const, title: rule.name.slice(0, 120), message, link: occ.link, metadata: { ruleId: rule.id, eventKey: occ.eventKey } })) })
      }
      await tx.automationRun.create({ data: { ...base, status: userIds.length ? "DONE" : "SKIPPED", detail: userIds.length ? `Notification envoyée dans l'application à ${userIds.length} administrateur(s)` : "Aucun administrateur actif à notifier", notified: userIds.length } })
      return userIds.length ? ("done" as const) : ("skipped" as const)
    })
  } catch (e) {
    // Clé d'événement déjà journalisée par un exécuteur concurrent : la transaction (action comprise) est annulée.
    // Seule la clé d'événement unique signifie « déjà fait » ; toute autre violation d'unicité est une vraie erreur.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && String((e.meta as { target?: unknown } | undefined)?.target ?? "").includes("eventKey")) return "duplicate"
    if (e instanceof Error && /automation rule is not active/.test(e.message)) return "inactive"
    throw e
  }
}

/**
 * Passe d'exécution : toutes les règles ACTIVES (d'une entreprise, ou de toutes pour la tâche planifiée), au plus
 * 200 occurrences par règle et par passe. Sans effet si aucune règle n'est active.
 */
export async function runAutomations(db: Db, opts: { companyId?: string; crmEnabled?: boolean } = {}, now: Date = serverNow()): Promise<RunSummary> {
  const today = parisToday(now)
  const crmEnabled = opts.crmEnabled ?? isCrmEnabled()
  // Revue Codex v1 (B1) : toutes les règles ACTIVES et DISPONIBLES (filtre de déclencheur appliqué dans la requête, avant
  // toute limite), lues par lots de 500 avec curseur : aucune famine au-delà de 500 règles.
  const triggers = availableTriggers(crmEnabled)
  const rules: ActiveRule[] = []
  let cursor: string | null = null
  do {
    const page: ActiveRule[] = await db.automationRule.findMany({
      where: { status: "ACTIVE", trigger: { in: triggers }, ...(opts.companyId ? { companyId: opts.companyId } : {}) },
      orderBy: [{ id: "asc" }], take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, companyId: true, name: true, trigger: true, stageFilter: true, action: true, taskTitle: true, taskAssigneeId: true, taskDueInDays: true, message: true, approvedById: true, activatedAt: true },
    })
    rules.push(...page)
    cursor = page.length === 500 ? page[page.length - 1].id : null
  } while (cursor !== null)
  const s: RunSummary = { rules: rules.length, done: 0, skipped: 0, duplicates: 0, errors: 0 }
  for (const rule of rules) {
    let list: Occurrence[]
    try {
      list = await occurrences(db, rule, today)
    } catch (e) {
      // Revue indépendante : une erreur inattendue sur une règle n'interrompt pas la passe des autres entreprises.
      console.error("[automations] lecture des occurrences en échec", { ruleId: rule.id, name: e instanceof Error ? e.name : typeof e })
      s.errors++
      continue
    }
    for (const occ of list) {
      let r: Awaited<ReturnType<typeof runOne>>
      try {
        r = await runOne(db, rule, occ, today)
      } catch (e) {
        // Transaction annulée (action comprise) : l'occurrence sera reprise à la passe suivante.
        console.error("[automations] occurrence en échec", { ruleId: rule.id, name: e instanceof Error ? e.name : typeof e })
        s.errors++
        continue
      }
      if (r === "inactive") break
      if (r === "done") s.done++
      else if (r === "skipped") s.skipped++
      else s.duplicates++
    }
  }
  return s
}
