/**
 * Page Employés — logique pure d'affichage (aucune mutation, aucun accès DB).
 *
 * Pipeline déterministe :
 *   données tenant (serveur) → onglet Actifs/Archivés/Tous → recherche → filtres → regroupement par fonction.
 *
 * « Archivé » est une présentation UX du drapeau existant `Employee.active = false`
 * (mis à jour par toggleEmployeActive) — pas un nouveau modèle métier.
 * La « fonction » est DÉDUITE pour l'affichage uniquement ; rien n'est persisté.
 */

export type EmployeeStateFilter = "active" | "archived" | "all"

export const EMPLOYEE_STATE_FILTERS: readonly EmployeeStateFilter[] = ["active", "archived", "all"] as const
export const DEFAULT_EMPLOYEE_STATE: EmployeeStateFilter = "active"

export const EMPLOYEE_STATE_LABELS: Record<EmployeeStateFilter, string> = {
  active: "Actifs",
  archived: "Archivés",
  all: "Tous",
}

export type EmployeeFunction = "chef" | "conducteur" | "technicien" | "autre"

/** Ordre de priorité d'affichage des sections. */
export const EMPLOYEE_FUNCTIONS: readonly EmployeeFunction[] = ["chef", "conducteur", "technicien", "autre"] as const

export const EMPLOYEE_FUNCTION_LABELS: Record<EmployeeFunction, string> = {
  chef: "Chefs d'équipe",
  conducteur: "Conducteurs de travaux",
  technicien: "Techniciens / Monteurs",
  autre: "Autres",
}

export interface EmployeeTeamRef {
  id: string
  name: string
  color: string | null
}

/** Modèle de vue construit côté serveur — aucune donnée de contact au-delà de l'existant. */
export interface EmployeeViewItem {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
  phone: string | null
  avatarUrl: string | null
  active: boolean
  /** Chef d'une équipe active (Team.leaderId) ou rôle TEAM_LEADER. */
  leadsTeam: boolean
  /** Équipe courante (TeamMember.leftAt = null), à défaut l'équipe dirigée. */
  team: EmployeeTeamRef | null
}

export const NO_TEAM = "__none__"

export interface EmployeeFilters {
  fonction: EmployeeFunction | null
  /** Id d'équipe, NO_TEAM pour « Sans équipe », null = toutes. */
  teamId: string | null
}

export const EMPTY_EMPLOYEE_FILTERS: EmployeeFilters = { fonction: null, teamId: null }

export interface EmployeeViewQuery {
  state: EmployeeStateFilter
  search: string
  filters: EmployeeFilters
}

/** Minuscules + suppression des accents. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}

const CHEF_RE = /\bchef\s*(d\s*['’]?\s*)?equipe\b/
const CONDUCTEUR_RE = /\bconducteur(s)?\s+de\s+travaux\b/
const TECHNICIEN_RE = /\b(technicien|monteur)/

/**
 * Fonction d'affichage, par priorité :
 * 1. chef d'équipe — donnée structurée (chef d'une équipe / rôle) OU poste « chef d'équipe » ;
 * 2. conducteur de travaux — poste explicite (« conducteur » seul = chauffeur, non classé ici) ;
 * 3. technicien / monteur — poste contenant technicien ou monteur ;
 * 4. autres.
 */
export function classifyEmployeeFunction(e: Pick<EmployeeViewItem, "jobTitle" | "leadsTeam">): EmployeeFunction {
  const title = normalizeText(e.jobTitle ?? "")
  if (e.leadsTeam || CHEF_RE.test(title)) return "chef"
  if (CONDUCTEUR_RE.test(title)) return "conducteur"
  if (TECHNICIEN_RE.test(title)) return "technicien"
  return "autre"
}

export function matchesEmployeeState(e: Pick<EmployeeViewItem, "active">, state: EmployeeStateFilter): boolean {
  if (state === "active") return e.active
  if (state === "archived") return !e.active
  return true
}

/** Recherche nom/prénom, poste, fonction et équipe. Tous les termes doivent correspondre (ET). */
export function matchesEmployeeSearch(e: EmployeeViewItem, search: string): boolean {
  const terms = normalizeText(search).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = normalizeText(
    [
      e.firstName,
      e.lastName,
      e.jobTitle ?? "",
      EMPLOYEE_FUNCTION_LABELS[classifyEmployeeFunction(e)],
      e.team?.name ?? "",
    ].join(" \u0000 ")
  )
  return terms.every((t) => haystack.includes(t))
}

export function matchesEmployeeFilters(e: EmployeeViewItem, filters: EmployeeFilters): boolean {
  if (filters.fonction && classifyEmployeeFunction(e) !== filters.fonction) return false
  if (filters.teamId) {
    if (filters.teamId === NO_TEAM) {
      if (e.team) return false
    } else if (e.team?.id !== filters.teamId) {
      return false
    }
  }
  return true
}

export function countActiveEmployeeFilters(filters: EmployeeFilters): number {
  return (filters.fonction ? 1 : 0) + (filters.teamId ? 1 : 0)
}

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true })

function compareEmployees(a: EmployeeViewItem, b: EmployeeViewItem): number {
  return (
    collator.compare(a.firstName, b.firstName) ||
    collator.compare(a.lastName, b.lastName) ||
    a.id.localeCompare(b.id)
  )
}

export interface EmployeeGroup {
  fonction: EmployeeFunction
  label: string
  items: EmployeeViewItem[]
}

export interface EmployeeViewResult {
  groups: EmployeeGroup[]
  total: number
  /** Compteurs par onglet, après recherche + filtres (sans le filtre d'onglet). */
  counts: Record<EmployeeStateFilter, number>
}

/** Applique le pipeline complet. Les groupes vides sont omis ; ordre des groupes = priorité métier. */
export function applyEmployeeView(
  employees: readonly EmployeeViewItem[],
  query: EmployeeViewQuery
): EmployeeViewResult {
  const counts: Record<EmployeeStateFilter, number> = { active: 0, archived: 0, all: 0 }
  const byFunction = new Map<EmployeeFunction, EmployeeViewItem[]>()

  for (const e of employees) {
    if (!matchesEmployeeSearch(e, query.search)) continue
    if (!matchesEmployeeFilters(e, query.filters)) continue
    for (const s of EMPLOYEE_STATE_FILTERS) if (matchesEmployeeState(e, s)) counts[s]++
    if (!matchesEmployeeState(e, query.state)) continue
    const f = classifyEmployeeFunction(e)
    const list = byFunction.get(f)
    if (list) list.push(e)
    else byFunction.set(f, [e])
  }

  const groups: EmployeeGroup[] = []
  let total = 0
  for (const f of EMPLOYEE_FUNCTIONS) {
    const items = byFunction.get(f)
    if (!items || items.length === 0) continue
    items.sort(compareEmployees)
    total += items.length
    groups.push({ fonction: f, label: EMPLOYEE_FUNCTION_LABELS[f], items })
  }
  return { groups, total, counts }
}

export interface EmployeeStats {
  active: number
  archived: number
  /** Les indicateurs par fonction ne comptent que les employés actifs. */
  chefs: number
  techniciens: number
  conducteurs: number
}

export function computeEmployeeStats(employees: readonly EmployeeViewItem[]): EmployeeStats {
  const stats: EmployeeStats = { active: 0, archived: 0, chefs: 0, techniciens: 0, conducteurs: 0 }
  for (const e of employees) {
    if (!e.active) {
      stats.archived++
      continue
    }
    stats.active++
    const f = classifyEmployeeFunction(e)
    if (f === "chef") stats.chefs++
    else if (f === "technicien") stats.techniciens++
    else if (f === "conducteur") stats.conducteurs++
  }
  return stats
}

export interface EmployeeFilterOption {
  id: string
  label: string
}

/** Équipes présentes dans les données autorisées (+ « Sans équipe » si pertinent). */
export function buildTeamOptions(employees: readonly EmployeeViewItem[]): EmployeeFilterOption[] {
  const byId = new Map<string, string>()
  let hasNoTeam = false
  for (const e of employees) {
    if (e.team) {
      if (!byId.has(e.team.id)) byId.set(e.team.id, e.team.name)
    } else {
      hasNoTeam = true
    }
  }
  const options = [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => collator.compare(a.label, b.label))
  if (hasNoTeam) options.push({ id: NO_TEAM, label: "Sans équipe" })
  return options
}

/** Ligne Prisma attendue par toEmployeeViewItem — reflète le select de la page. */
export interface EmployeeRow {
  id: string
  companyId: string
  firstName: string
  lastName: string
  jobTitle: string | null
  phone: string | null
  avatarUrl: string | null
  active: boolean
  user: { role: string }
  teamMemberships: { team: { id: string; name: string; color: string | null; companyId: string } }[]
  ledTeams: { id: string; name: string; color: string | null; companyId: string }[]
}

/**
 * Projection serveur → client. Défense en profondeur : ignore toute ligne ou équipe
 * d'un autre tenant, même si la requête est déjà scopée par companyId.
 */
export function toEmployeeViewItems(rows: readonly EmployeeRow[], companyId: string): EmployeeViewItem[] {
  const items: EmployeeViewItem[] = []
  for (const r of rows) {
    if (r.companyId !== companyId) continue
    const memberTeam = r.teamMemberships.find((m) => m.team.companyId === companyId)?.team
    const ledTeam = r.ledTeams.find((t) => t.companyId === companyId)
    const team = memberTeam ?? ledTeam ?? null
    items.push({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      jobTitle: r.jobTitle,
      phone: r.phone,
      avatarUrl: r.avatarUrl,
      active: r.active,
      leadsTeam: Boolean(ledTeam) || r.user.role === "TEAM_LEADER",
      team: team ? { id: team.id, name: team.name, color: team.color } : null,
    })
  }
  return items
}
