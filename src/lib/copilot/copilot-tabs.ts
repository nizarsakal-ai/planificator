/**
 * Assistant IA, étape 2 : onglets Discussion, Propositions et Journal (cadrage docs/assistant-navigation-onglets.cadrage.md).
 * Navigation fusionnée, moteurs séparés. Les onglets sont décidés par le SERVEUR ; chaque route de lecture refait sa garde.
 *
 * Deux sources, deux gardes DISTINCTES, chacune limitée aux administrateurs du tenant concerné :
 * - règles locales (lot F) : garde de la route /assistant (`resolveAssistantAccess` : drapeau, société cible, ADMIN/SUPER_ADMIN) ;
 * - assistant IA : copilote configuré pour la société de session ET rôle ADMIN/SUPER_ADMIN.
 * Une source n'est lue que si SA garde accepte, et seulement pour la société que cette garde a validée.
 */
import type { PrismaClient } from "@prisma/client"
import { RULE_LABEL, type AssistantRule } from "@/lib/assistant/assistant.core"
import { COPILOT_ACTION_ENTITY } from "@/lib/copilot/copilot-execute"

type Db = Pick<PrismaClient, "assistantProposal" | "assistantActionLog" | "historyLog">

export type CopilotTab = "discussion" | "propositions" | "journal"

/** Résultat d'une garde : société validée, ou statut HTTP du refus. */
export type SourceGuard = { ok: true; companyId: string } | { ok: false; status: 401 | 403 | 404 }

/** Onglets visibles : Discussion si le copilote est visible ; Propositions si la garde des règles accepte ; Journal si
 *  au moins une source du journal est autorisée pour un administrateur. Un seul onglet ⇒ pas de barre d'onglets. */
export function resolveCopilotTabs(input: { copilotVisible: boolean; rules: SourceGuard; copilotAdmin: SourceGuard }): CopilotTab[] {
  if (!input.copilotVisible) return []
  const tabs: CopilotTab[] = ["discussion"]
  if (input.rules.ok) tabs.push("propositions")
  if (input.copilotAdmin.ok || input.rules.ok) tabs.push("journal")
  return tabs
}

/** Statut du refus du journal quand AUCUNE source n'est autorisée : 404 si aucun module n'existe pour la société,
 *  401 sans session, 403 sinon (rôle non administrateur). `null` si au moins une source est autorisée. */
export function journalDenial(rules: SourceGuard, copilotAdmin: SourceGuard): 401 | 403 | 404 | null {
  if (rules.ok || copilotAdmin.ok) return null
  const statuses = [rules.status, copilotAdmin.status]
  if (statuses.every((s) => s === 404)) return 404
  if (statuses.includes(401)) return 401
  return 403
}

export const MAX_PROPOSALS_TAB = 50
export const MAX_JOURNAL_ROWS = 50

export interface PendingProposal { id: string; rule: string; title: string; createdAt: string; href: string }

/** Propositions en attente du lot F, champs d'affichage seulement (ni payload, ni sources détaillées). */
export async function readPendingProposals(db: Db, guard: SourceGuard): Promise<PendingProposal[]> {
  if (!guard.ok) return []
  const rows = await db.assistantProposal.findMany({
    where: { companyId: guard.companyId, status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_PROPOSALS_TAB,
    select: { id: true, rule: true, title: true, createdAt: true },
  })
  return rows.map((p) => ({
    id: p.id, rule: RULE_LABEL[p.rule as AssistantRule] ?? p.rule, title: p.title, createdAt: p.createdAt.toISOString(),
    href: `/assistant#proposition-${p.id}`,
  }))
}

export type JournalSource = "regles" | "assistant-ia"
export interface JournalRow { id: string; source: JournalSource; date: string; event: string; detail: string }

const RULES_EVENT: Record<string, string> = { GENERATED: "Proposée", EXECUTED: "Exécutée", REJECTED: "Refusée", OBSOLETE: "Périmée" }
const COPILOT_KIND: Record<string, string> = {
  TASK: "Tâche créée", ASSIGNMENT: "Équipe affectée", QUOTE: "Brouillon de devis créé", AUTOMATION: "Règle d'automatisation créée (brouillon)",
}

/** Journal fusionné par date. Chaque source n'est lue que si SA garde accepte, pour la société validée par cette garde ;
 *  si les deux gardes valident des sociétés différentes, seule la source du copilote (société de session) est gardée. */
export async function readJournal(db: Db, guards: { rules: SourceGuard; copilotAdmin: SourceGuard }): Promise<JournalRow[]> {
  const { rules, copilotAdmin } = guards
  const sameTenant = !rules.ok || !copilotAdmin.ok || rules.companyId === copilotAdmin.companyId
  const [ruleRows, copilotRows] = await Promise.all([
    rules.ok && sameTenant
      ? db.assistantActionLog.findMany({
        where: { companyId: rules.companyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_JOURNAL_ROWS,
        select: { id: true, event: true, detail: true, createdAt: true },
      })
      : Promise.resolve([]),
    copilotAdmin.ok
      ? db.historyLog.findMany({
        where: { companyId: copilotAdmin.companyId, entityType: COPILOT_ACTION_ENTITY }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_JOURNAL_ROWS,
        select: { id: true, detail: true, createdAt: true },
      })
      : Promise.resolve([]),
  ])
  const merged: JournalRow[] = [
    ...ruleRows.map((r) => ({ id: `r:${r.id}`, source: "regles" as const, date: r.createdAt.toISOString(), event: RULES_EVENT[r.event] ?? r.event, detail: r.detail.slice(0, 300) })),
    ...copilotRows.map((c) => {
      const kind = (c.detail ?? "").replace(/^Assistant IA : /, "")
      return { id: `c:${c.id}`, source: "assistant-ia" as const, date: c.createdAt.toISOString(), event: "Confirmée", detail: COPILOT_KIND[kind] ?? "Action confirmée" }
    }),
  ]
  return merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1)).slice(0, MAX_JOURNAL_ROWS)
}
