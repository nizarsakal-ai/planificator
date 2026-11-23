/**
 * IA-2 : exécution d'une proposition confirmée. Une proposition ne s'exécute qu'une fois (réservation de son numéro
 * dans le journal, sous verrou) et passe par les fonctions de l'interface (tâches, affectations, devis), qui refont
 * leurs propres contrôles de session, de rôle, de société et de données. Le journal garde le type d'action et l'auteur.
 */
import type { PrismaClient } from "@prisma/client"
import type { ProposalPayload } from "@/lib/copilot/copilot-proposal"

export const COPILOT_ACTION_ENTITY = "CopilotAction"

export type ExecuteResult = { ok: true; message: string; href?: string } | { ok: false; error: string }

export interface ExecutePorts {
  createTask: (formData: FormData) => Promise<{ success: true } | { error: string }>
  assignTeam: (formData: FormData) => Promise<{ success?: boolean; count?: number; error?: string }>
  createQuote: (raw: unknown) => Promise<{ ok: true; id: string; number: string } | { ok: false; error: string }>
  createRule: (formData: FormData) => Promise<{ etat: "initial" | "ok" | "erreur"; message: string }>
}

/** Réserve le numéro de la proposition ; `false` si elle a déjà été confirmée. */
export async function reserveProposal(db: PrismaClient, input: { companyId: string; actorId: string; nonce: string; kind: string }): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`copilot-action:${input.nonce}`}, 0))`
    const seen = await tx.historyLog.count({ where: { companyId: input.companyId, entityType: COPILOT_ACTION_ENTITY, entityId: input.nonce } })
    if (seen > 0) return false
    await tx.historyLog.create({
      data: { companyId: input.companyId, actorId: input.actorId, action: "CREATED", entityType: COPILOT_ACTION_ENTITY, entityId: input.nonce, detail: `Assistant IA : ${input.kind}` },
    })
    return true
  }, { isolationLevel: "ReadCommitted" })
}

export async function releaseProposal(db: PrismaClient, input: { companyId: string; nonce: string }): Promise<void> {
  await db.historyLog.deleteMany({ where: { companyId: input.companyId, entityType: COPILOT_ACTION_ENTITY, entityId: input.nonce } })
}

const form = (fields: Record<string, string | null>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== "") f.set(k, v)
  return f
}

export async function executeProposal(payload: ProposalPayload, ports: ExecutePorts): Promise<ExecuteResult> {
  switch (payload.kind) {
    case "TASK": {
      const d = payload.data
      const r = await ports.createTask(form({ title: d.title, description: d.description, priority: d.priority, dueDate: d.dueDate, assigneeId: d.assigneeId, worksiteId: d.worksiteId }))
      return "error" in r ? { ok: false, error: r.error } : { ok: true, message: "Tâche créée.", href: "/dashboard" }
    }
    case "ASSIGNMENT": {
      const d = payload.data
      const r = await ports.assignTeam(form({ worksiteId: d.worksiteId, teamId: d.teamId, dateFrom: d.dateFrom, dateTo: d.dateTo }))
      if (r.error || !r.success) return { ok: false, error: r.error ?? "Affectation impossible." }
      return { ok: true, message: `Équipe affectée (${r.count ?? 1} jour${(r.count ?? 1) > 1 ? "s" : ""}).`, href: `/chantiers/${d.worksiteId}` }
    }
    case "QUOTE": {
      const d = payload.data
      const r = await ports.createQuote({
        worksiteId: d.worksiteId, issueDate: d.issueDate, subject: d.subject ?? "",
        lines: d.lines.map(l => ({ articleId: l.articleId, designation: l.designation, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })),
      })
      return r.ok ? { ok: true, message: `Brouillon de devis ${r.number} créé.`, href: `/devis/${r.id}` } : { ok: false, error: r.error }
    }
    case "AUTOMATION": {
      const d = payload.data
      const r = await ports.createRule(form({
        name: d.name, trigger: d.trigger, action: d.action, stageFilter: d.stageFilter,
        taskTitle: d.taskTitle, taskAssigneeId: d.taskAssigneeId, taskDueInDays: d.taskDueInDays === null ? null : String(d.taskDueInDays), message: d.message,
      }))
      return r.etat === "ok" ? { ok: true, message: "Règle créée en brouillon : approuvez-la dans Automatisations pour l'activer.", href: "/automatisations" } : { ok: false, error: r.message || "Règle impossible à créer." }
    }
    default:
      return { ok: false, error: "Action inconnue." }
  }
}
