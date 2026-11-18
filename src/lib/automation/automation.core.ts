/**
 * Lot E Planificator V2 : automatisations bornées — règles PURES.
 *
 * - Déclencheurs internes en LISTE FERMÉE : changement d'étape d'une opportunité (filtre d'étape facultatif), relance
 *   d'opportunité arrivée à échéance, devis accepté. Les deux déclencheurs d'opportunité n'existent que si le pipeline
 *   commercial est actif (CRM_OPPORTUNITIES_ENABLED) : sinon ils ne sont ni proposés, ni créés, ni approuvés, ni exécutés.
 * - Actions limitées : créer une tâche interne, ou notifier les administrateurs dans l'application. Aucune action
 *   n'envoie de courrier électronique ni n'appelle un service extérieur.
 * - Une règle est créée en brouillon ; elle n'agit qu'après une approbation explicite (qui l'active). Sa configuration
 *   est figée : la modifier, c'est la désactiver et en créer une autre. Désactivation immédiate.
 * - Une exécution par événement et par règle : chaque événement a une clé stable (`eventKey`), unique par règle en base.
 * - Les gabarits n'admettent que des champs nommés ({numero}, {titre}, {client}, {chantier}, {etape}, {date}) remplacés
 *   par du texte brut ; tout autre motif reste tel quel.
 */
// Lot E sur main : « réserve de réception en retard » RETIRÉ (dépend des réserves du lot D, absent de main) ; à réintroduire avec D.
export type AutomationTrigger = "OPPORTUNITY_STAGE_CHANGED" | "OPPORTUNITY_FOLLOW_UP_DUE" | "QUOTE_ACCEPTED"
export type AutomationAction = "CREATE_TASK" | "NOTIFY_ADMINS"
export const TRIGGERS: readonly AutomationTrigger[] = ["OPPORTUNITY_STAGE_CHANGED", "OPPORTUNITY_FOLLOW_UP_DUE", "QUOTE_ACCEPTED"]
export const ACTIONS: readonly AutomationAction[] = ["CREATE_TASK", "NOTIFY_ADMINS"]
export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  OPPORTUNITY_STAGE_CHANGED: "Changement d'étape d'une opportunité",
  OPPORTUNITY_FOLLOW_UP_DUE: "Relance d'opportunité arrivée à échéance",
  QUOTE_ACCEPTED: "Devis accepté",
}
/**
 * Portée d'une règle à son activation (revue coordinateur v3 : comportement explicité, NON modifié).
 * - Changement d'étape et devis accepté : seuls les événements postérieurs à l'activation déclenchent (borne `activatedAt`).
 * - Relance due : c'est un état, pas un événement daté. Toute relance échue (date de relance atteinte, opportunité ouverte)
 *   non encore traitée par la règle déclenche, y compris l'arriéré déjà échu à l'activation ou à une réapprobation ;
 *   une seule fois par opportunité et par date de relance (clé `ofu:<opportunité>:<jour>`, jamais rejouée).
 */
export const ACTIVATION_SCOPE: Record<AutomationTrigger, string> = {
  OPPORTUNITY_STAGE_CHANGED: "Seuls les changements d'étape postérieurs à l'activation déclenchent la règle.",
  OPPORTUNITY_FOLLOW_UP_DUE: "Toute relance échue et non encore traitée déclenche la règle, y compris les relances déjà échues à l'activation ; une seule fois par opportunité et par date de relance.",
  QUOTE_ACCEPTED: "Seuls les devis acceptés après l'activation déclenchent la règle.",
}
/** Déclencheurs qui lisent les opportunités : indisponibles tant que le pipeline commercial est désactivé. */
export const CRM_TRIGGERS: readonly AutomationTrigger[] = ["OPPORTUNITY_STAGE_CHANGED", "OPPORTUNITY_FOLLOW_UP_DUE"]
export function isTriggerAvailable(trigger: string, crmEnabled: boolean): boolean {
  if (!(TRIGGERS as readonly string[]).includes(trigger)) return false
  return crmEnabled || !(CRM_TRIGGERS as readonly string[]).includes(trigger)
}
export function availableTriggers(crmEnabled: boolean): AutomationTrigger[] {
  return TRIGGERS.filter((t) => isTriggerAvailable(t, crmEnabled))
}
/**
 * Exécution concurrente : l'occurrence n'est traitée que si la règle, relue sous verrou, est ACTIVE et porte la MÊME
 * activation que lors de la sélection (une désactivation puis une réapprobation intercalées changent `activatedAt` :
 * les occurrences sélectionnées sous l'ancienne approbation ne sont pas exécutées, la passe suivante repart de la nouvelle).
 */
export function sameActivation(locked: { status: string; activatedAt: Date | null } | undefined, selected: { activatedAt: Date | null }): boolean {
  if (!locked || locked.status !== "ACTIVE" || !locked.activatedAt || !selected.activatedAt) return false
  return locked.activatedAt.getTime() === selected.activatedAt.getTime()
}
export const ACTION_LABEL: Record<AutomationAction, string> = { CREATE_TASK: "Créer une tâche interne", NOTIFY_ADMINS: "Notifier les administrateurs (dans l'application)" }
export const MAX_EVENTS_PER_RULE_RUN = 200
export const TEMPLATE_FIELDS = ["numero", "titre", "client", "chantier", "etape", "date"] as const
export type TemplateVars = Partial<Record<(typeof TEMPLATE_FIELDS)[number], string | null>>

export const AUTOMATION_ERRORS = {
  notFound: "Élément introuvable.",
  name: "Nom obligatoire (3 à 120 caractères).",
  trigger: "Déclencheur invalide.",
  action: "Action invalide.",
  stageFilter: "Le filtre d'étape ne s'applique qu'au changement d'étape d'une opportunité.",
  taskTitle: "Intitulé de tâche obligatoire (3 à 200 caractères).",
  dueInDays: "Échéance de tâche invalide (0 à 365 jours).",
  message: "Message obligatoire (3 à 500 caractères).",
  notDraftOrDisabled: "Seule une règle en brouillon ou désactivée peut être approuvée et activée.",
  notActive: "Cette règle n'est pas active.",
  assigneeInactive: "Responsable de la tâche introuvable ou inactif : action non exécutée.",
  triggerUnavailable: "Ce déclencheur exige le pipeline commercial, actuellement désactivé.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })
const clean = (v: string | null | undefined) => (v ?? "").trim()

export interface RuleInput {
  name: string; trigger: string; action: string; stageFilter?: string | null
  taskTitle?: string | null; taskAssigneeId?: string | null; taskDueInDays?: number | null; message?: string | null
}
export interface RuleConfig {
  name: string; trigger: AutomationTrigger; action: AutomationAction; stageFilter: string | null
  taskTitle: string | null; taskAssigneeId: string | null; taskDueInDays: number | null; message: string | null
}
export function validateRule(input: RuleInput, stages: readonly string[]): Plan<RuleConfig> {
  const name = clean(input.name)
  if (name.length < 3 || name.length > 120) return ko(AUTOMATION_ERRORS.name)
  if (!(TRIGGERS as readonly string[]).includes(input.trigger)) return ko(AUTOMATION_ERRORS.trigger)
  if (!(ACTIONS as readonly string[]).includes(input.action)) return ko(AUTOMATION_ERRORS.action)
  const trigger = input.trigger as AutomationTrigger, action = input.action as AutomationAction
  const stageFilter = clean(input.stageFilter) || null
  if (stageFilter && (trigger !== "OPPORTUNITY_STAGE_CHANGED" || !stages.includes(stageFilter))) return ko(AUTOMATION_ERRORS.stageFilter)
  if (action === "CREATE_TASK") {
    const taskTitle = clean(input.taskTitle)
    if (taskTitle.length < 3 || taskTitle.length > 200) return ko(AUTOMATION_ERRORS.taskTitle)
    const d = input.taskDueInDays ?? null
    if (d !== null && (!Number.isSafeInteger(d) || d < 0 || d > 365)) return ko(AUTOMATION_ERRORS.dueInDays)
    return { ok: true, value: { name, trigger, action, stageFilter, taskTitle, taskAssigneeId: clean(input.taskAssigneeId) || null, taskDueInDays: d, message: null } }
  }
  const message = clean(input.message)
  if (message.length < 3 || message.length > 500) return ko(AUTOMATION_ERRORS.message)
  return { ok: true, value: { name, trigger, action, stageFilter, taskTitle: null, taskAssigneeId: null, taskDueInDays: null, message } }
}

/** Remplace les seuls champs connus par leur valeur en texte brut (contrôles retirés), puis borne la longueur. */
export function renderTemplate(template: string, vars: TemplateVars, maxLength: number): string {
  const out = template.replace(/\{(numero|titre|client|chantier|etape|date)\}/g, (_, k: keyof TemplateVars) => {
    // eslint-disable-next-line no-control-regex
    return (vars[k] ?? "—").replace(/[\u0000-\u001f\u007f]/g, " ")
  })
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out
}

/** Clés d'événement stables : la même occurrence donne toujours la même clé (idempotence). */
export const eventKeys = {
  stageChanged: (eventId: string) => `ose:${eventId}`,
  followUpDue: (opportunityId: string, day: string) => `ofu:${opportunityId}:${day}`,
  quoteAccepted: (quoteId: string, acceptedAt: Date) => `qa:${quoteId}:${acceptedAt.toISOString()}`,
}

/** Échéance d'une tâche créée : jour civil courant (Paris) + N jours, à midi UTC pour rester sur le bon jour affiché. */
export function taskDueDate(today: Date, days: number | null): Date | null {
  if (days === null) return null
  return new Date(today.getTime() + days * 86_400_000 + 12 * 3_600_000)
}
