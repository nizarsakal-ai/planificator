/**
 * Lot F Planificator V2 : assistant — règles PURES (fournisseur LOCAL_RULES).
 *
 * L'assistant observe des faits de l'entreprise et PROPOSE une action ; il n'agit jamais seul. Chaque proposition :
 * - cite ses sources (type, identifiant, libellé, lien, fait observé) ;
 * - porte une clé de source stable : la même observation n'est proposée qu'une fois (même refusée) ;
 * - n'a qu'un type d'action, créer une tâche interne, exécutée seulement après approbation explicite, et seulement si
 *   les sources la justifient toujours au moment de l'approbation (sinon la proposition est déclarée périmée).
 * Règles (chacune seulement si le module source est activé) : relance d'opportunité du pipeline commercial en retard
 * (lot E, CRM_OPPORTUNITIES_ENABLED) et stock sous le seuil minimal (lot A, STOCK_PURCHASING_ENABLED).
 * Portage sur ab987847 (19/11/2026) : la règle « réserve de réception en retard » est REPORTÉE avec le lot D (absent de
 * cette base) ; aucune donnée ni route du lot D n'est lue. La valeur `RESERVE_OVERDUE` reste admise par la contrainte de
 * la migration v6 (inchangée), mais aucun code de ce lot ne la produit.
 */
import { formatDay, parseDay } from "@/lib/equipment/equipment.core"

export type AssistantRule = "OPPORTUNITY_FOLLOW_UP_OVERDUE" | "STOCK_BELOW_MINIMUM"
export const RULE_LABEL: Record<AssistantRule, string> = {
  OPPORTUNITY_FOLLOW_UP_OVERDUE: "Relance d'opportunité en retard",
  STOCK_BELOW_MINIMUM: "Stock sous le seuil minimal",
}
export const MAX_FACTS_PER_RULE = 50

export type SourceType = "Opportunity" | "StockLevel"
export const SOURCE_TYPES: readonly SourceType[] = ["Opportunity", "StockLevel"]
export interface ProposalSource { type: SourceType; id: string; label: string; href: string; fact: string }
export interface TaskPayload { title: string; dueDate: string; worksiteId: string | null; priority: "MEDIUM" | "HIGH" }
export interface ProposalDraft { rule: AssistantRule; sourceKey: string; title: string; rationale: string; payload: TaskPayload; sources: ProposalSource[] }

export interface FollowUpFact { id: string; number: string; title: string; party: string; worksiteId: string | null; nextFollowUpDate: Date; open: boolean }
export interface StockFact { id: string; articleName: string; warehouseName: string; unit: string; quantityMilli: number; minQuantityMilli: number }
export interface Facts { followUps?: readonly FollowUpFact[]; stock?: readonly StockFact[] }

export const ASSISTANT_ERRORS = {
  notFound: "Proposition introuvable.",
  decided: "Cette proposition a déjà été traitée.",
  title: "Intitulé de tâche obligatoire (3 à 200 caractères).",
  dueDate: "Échéance invalide.",
  assignee: "Responsable introuvable ou inactif.",
  note: "Motif trop long (500 caractères au plus).",
  obsolete: "Les sources ne justifient plus cette proposition : elle est déclarée périmée, aucune tâche n'a été créée.",
  sourceDisabled: "Module source désactivé : la proposition reste en attente, aucune tâche n'a été créée. Réactivez le module pour l'approuver.",
} as const

/** Modules sources activés (drapeaux lus côté serveur) : même décision à la génération et à l'approbation. */
export interface EnabledSources { crm: boolean; stock: boolean }
/** Module source de chaque règle : pipeline commercial (lot E) ou stock (lot A). */
export const RULE_SOURCE: Record<AssistantRule, keyof EnabledSources> = {
  OPPORTUNITY_FOLLOW_UP_OVERDUE: "crm",
  STOCK_BELOW_MINIMUM: "stock",
}
/** Le module source de la règle est-il activé ? Règle inconnue : `true` (la relecture de la source la déclarera périmée). */
export function isRuleSourceEnabled(rule: string, enabled: EnabledSources): boolean {
  const source = (RULE_SOURCE as Record<string, keyof EnabledSources | undefined>)[rule]
  return source === undefined ? true : enabled[source] === true
}

const DAY_MS = 86_400_000
// Jours civils (minuit UTC du jour) : écart exact ; au moins 1 puisqu'un fait retenu est strictement antérieur.
const daysBetween = (a: Date, b: Date) => Math.max(1, Math.round((b.getTime() - a.getTime()) / DAY_MS))
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const qty = (milli: number, unit: string) => `${(milli / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 3 })} ${unit}`.trim()

/** Semaine ISO (AAAA-Www) d'un jour : une alerte de stock au plus une fois par semaine et par seuil. */
export function isoWeek(day: Date): string {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

export const sourceKeys = {
  followUp: (id: string, day: Date) => `fu:${id}:${formatDay(day)}`,
  stock: (id: string, minMilli: number, today: Date) => `stk:${id}:${minMilli}:${isoWeek(today)}`,
}

/** Lien interne de la source : fiche du pipeline commercial du lot E (pas la veille Prospection `/opportunites`). */
export const sourceHref = {
  opportunity: (id: string) => `/crm/opportunites/${id}`,
  stock: () => "/stock",
}

/** Un fait justifie-t-il (encore) une proposition ? Même test à la génération et à l'approbation. */
export const holds = {
  followUp: (f: FollowUpFact, today: Date) => f.open && f.nextFollowUpDate.getTime() < today.getTime(),
  stock: (f: StockFact) => f.minQuantityMilli > 0 && f.quantityMilli < f.minQuantityMilli,
}

/** Propositions déduites des faits, triées de façon stable (règle, puis clé de source). */
export function proposeFromFacts(facts: Facts, today: Date): ProposalDraft[] {
  const out: ProposalDraft[] = []
  const due = formatDay(today)
  for (const f of facts.followUps ?? []) {
    if (!holds.followUp(f, today)) continue
    const late = daysBetween(f.nextFollowUpDate, today)
    out.push({
      rule: "OPPORTUNITY_FOLLOW_UP_OVERDUE", sourceKey: sourceKeys.followUp(f.id, f.nextFollowUpDate),
      title: clip(`Relancer ${f.party} (${f.number})`, 200),
      rationale: `Relance prévue le ${formatDay(f.nextFollowUpDate)} pour « ${clip(f.title, 120)} », non faite (${late} jour${late > 1 ? "s" : ""} de retard).`,
      payload: { title: clip(`Relancer ${f.party} (${f.number})`, 200), dueDate: due, worksiteId: f.worksiteId, priority: late > 7 ? "HIGH" : "MEDIUM" },
      sources: [{ type: "Opportunity", id: f.id, label: `${f.number} · ${clip(f.title, 80)}`, href: sourceHref.opportunity(f.id), fact: `Relance prévue le ${formatDay(f.nextFollowUpDate)}` }],
    })
  }
  for (const f of facts.stock ?? []) {
    if (!holds.stock(f)) continue
    out.push({
      rule: "STOCK_BELOW_MINIMUM", sourceKey: sourceKeys.stock(f.id, f.minQuantityMilli, today),
      title: clip(`Réapprovisionner ${f.articleName} (${f.warehouseName})`, 200),
      rationale: `Stock de ${qty(f.quantityMilli, f.unit)} pour un seuil minimal de ${qty(f.minQuantityMilli, f.unit)} au dépôt ${f.warehouseName}.`,
      payload: { title: clip(`Réapprovisionner ${f.articleName} (${f.warehouseName})`, 200), dueDate: due, worksiteId: null, priority: f.quantityMilli <= 0 ? "HIGH" : "MEDIUM" },
      sources: [{ type: "StockLevel", id: f.id, label: `${clip(f.articleName, 80)} · ${clip(f.warehouseName, 60)}`, href: sourceHref.stock(), fact: `Stock ${qty(f.quantityMilli, f.unit)} < seuil ${qty(f.minQuantityMilli, f.unit)}` }],
    })
  }
  return out.sort((a, b) => (a.rule === b.rule ? (a.sourceKey < b.sourceKey ? -1 : 1) : a.rule < b.rule ? -1 : 1))
}

export interface ApprovalInput { title?: string | null; dueDate?: string | null; assigneeId?: string | null }
export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }

/** Ajustements humains à l'approbation : intitulé et échéance modifiables, responsable facultatif. */
export function validateApproval(payload: TaskPayload, input: ApprovalInput): Plan<{ title: string; dueDate: Date | null; assigneeId: string | null }> {
  const title = (input.title ?? payload.title).trim()
  if (title.length < 3 || title.length > 200) return { ok: false, error: ASSISTANT_ERRORS.title }
  const rawDue = (input.dueDate ?? payload.dueDate ?? "").trim()
  let dueDate: Date | null = null
  if (rawDue) {
    const d = parseDay(rawDue)
    if (!d) return { ok: false, error: ASSISTANT_ERRORS.dueDate }
    dueDate = new Date(d.getTime() + 12 * 3_600_000)
  }
  return { ok: true, value: { title, dueDate, assigneeId: (input.assigneeId ?? "").trim() || null } }
}

/** Relecture prudente d'une charge utile stockée (JSON) : toute forme inattendue est refusée. */
export function readPayload(raw: unknown): TaskPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (typeof p.title !== "string" || typeof p.dueDate !== "string" || (p.worksiteId !== null && typeof p.worksiteId !== "string") || (p.priority !== "MEDIUM" && p.priority !== "HIGH")) return null
  return { title: p.title, dueDate: p.dueDate, worksiteId: p.worksiteId as string | null, priority: p.priority }
}
export function readSources(raw: unknown): ProposalSource[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is ProposalSource => !!s && typeof s === "object" && (SOURCE_TYPES as readonly string[]).includes((s as ProposalSource).type) && typeof (s as ProposalSource).id === "string" && typeof (s as ProposalSource).label === "string" && typeof (s as ProposalSource).href === "string" && /^\/(?!\/)/.test((s as ProposalSource).href) && typeof (s as ProposalSource).fact === "string")
}
