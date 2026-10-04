/**
 * Page Chantiers — logique pure d'affichage (aucune mutation, aucun accès DB).
 *
 * Pipeline déterministe :
 *   données tenant (serveur) → état → recherche → filtres complémentaires → tri → rendu.
 *
 * Les catégories d'état reposent UNIQUEMENT sur le statut persisté `Worksite.status`,
 * maintenu par le cron /api/cron/chantiers et les actions manuelles.
 * Aucune déduction « dateFin < aujourd'hui ⇒ terminé » n'est faite ici.
 */

export type WorksiteStatusValue =
  | "PLANNED"
  | "IN_PROGRESS"
  | "EXTENDED"
  | "DELAYED"
  | "COMPLETED"
  | "ARCHIVED"

export type ChantierStateFilter = "active" | "unassigned" | "planned" | "done" | "all"

export const CHANTIER_STATE_FILTERS: readonly ChantierStateFilter[] = [
  "active",
  "unassigned",
  "planned",
  "done",
  "all",
] as const

export const DEFAULT_STATE_FILTER: ChantierStateFilter = "active"

export const STATE_FILTER_LABELS: Record<ChantierStateFilter, string> = {
  active: "Actifs",
  unassigned: "À affecter",
  planned: "Planifiés",
  done: "Terminés",
  all: "Tous",
}

export type ChantierSort =
  | "start-asc"
  | "start-desc"
  | "end-asc"
  | "end-desc"
  | "name-asc"
  | "name-desc"

/** Ordre historique de la page (orderBy startDate asc côté serveur). */
export const DEFAULT_SORT: ChantierSort = "start-asc"

export const SORT_LABELS: Record<ChantierSort, string> = {
  "start-asc": "Date de début : plus ancienne d'abord",
  "start-desc": "Date de début : plus récente d'abord",
  "end-asc": "Date de fin : plus ancienne d'abord",
  "end-desc": "Date de fin : plus récente d'abord",
  "name-asc": "Nom : A → Z",
  "name-desc": "Nom : Z → A",
}

/** Sous-ensemble des champs nécessaires au filtrage — compatible avec le payload de la page. */
export interface FilterableChantier {
  id: string
  name: string
  address: string | null
  status: string
  startDate: Date | null
  endDate: Date | null
  clientId: string
  client: { name: string }
  _count: { assignments: number }
  /** Employés réellement affectés (EmployeeAssignment), dédupliqués côté serveur. */
  employeeIds: string[]
}

export interface ChantierComplementaryFilters {
  clientId: string | null
  employeeId: string | null
}

export const EMPTY_COMPLEMENTARY_FILTERS: ChantierComplementaryFilters = {
  clientId: null,
  employeeId: null,
}

export interface ChantierViewQuery {
  state: ChantierStateFilter
  search: string
  filters: ChantierComplementaryFilters
  sort: ChantierSort
}

const ACTIVE_STATUSES = new Set<string>(["IN_PROGRESS", "EXTENDED"])
/** DELAYED = « démarrage repoussé » (le cron le repasse IN_PROGRESS à delayedUntil). */
const PLANNED_STATUSES = new Set<string>(["PLANNED", "DELAYED"])
const DONE_STATUSES = new Set<string>(["COMPLETED", "ARCHIVED"])

/** Règle « À affecter » existante de ChantiersView, reprise à l'identique. */
export function isUnassigned(c: Pick<FilterableChantier, "status" | "_count">): boolean {
  return c.status === "PLANNED" && c._count.assignments === 0
}

export function matchesState(
  c: Pick<FilterableChantier, "status" | "_count">,
  state: ChantierStateFilter
): boolean {
  switch (state) {
    case "active":
      return ACTIVE_STATUSES.has(c.status)
    case "planned":
      return PLANNED_STATUSES.has(c.status)
    case "done":
      return DONE_STATUSES.has(c.status)
    case "unassigned":
      return isUnassigned(c)
    case "all":
      return true
  }
}

/** Minuscules + suppression des accents : « Chénôve » ≈ « chenove ». */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}

/**
 * Recherche sur nom, client et adresse (l'adresse contient ville + code postal :
 * le modèle Worksite n'a pas de champs ville / CP / référence séparés).
 * Tous les termes doivent être présents (ET), dans n'importe quel champ.
 */
export function matchesSearch(
  c: Pick<FilterableChantier, "name" | "address" | "client">,
  search: string
): boolean {
  const terms = normalizeSearchText(search).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = normalizeSearchText([c.name, c.client.name, c.address ?? ""].join(" \u0000 "))
  return terms.every((t) => haystack.includes(t))
}

export function matchesComplementaryFilters(
  c: Pick<FilterableChantier, "clientId" | "employeeIds">,
  filters: ChantierComplementaryFilters
): boolean {
  if (filters.clientId && c.clientId !== filters.clientId) return false
  if (filters.employeeId && !c.employeeIds.includes(filters.employeeId)) return false
  return true
}

export function countActiveComplementaryFilters(filters: ChantierComplementaryFilters): number {
  return (filters.clientId ? 1 : 0) + (filters.employeeId ? 1 : 0)
}

const nameCollator = new Intl.Collator("fr", { sensitivity: "base", numeric: true })

function compareDates(a: Date | null, b: Date | null, direction: 1 | -1): number {
  // Dates inconnues toujours en fin de liste, quel que soit le sens.
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return (new Date(a).getTime() - new Date(b).getTime()) * direction
}

export function compareChantiers<T extends Pick<FilterableChantier, "id" | "name" | "startDate" | "endDate">>(
  a: T,
  b: T,
  sort: ChantierSort
): number {
  let result: number
  switch (sort) {
    case "name-asc":
      result = nameCollator.compare(a.name, b.name)
      break
    case "name-desc":
      result = nameCollator.compare(b.name, a.name)
      break
    case "start-asc":
      result = compareDates(a.startDate, b.startDate, 1)
      break
    case "start-desc":
      result = compareDates(a.startDate, b.startDate, -1)
      break
    case "end-asc":
      result = compareDates(a.endDate, b.endDate, 1)
      break
    case "end-desc":
      result = compareDates(a.endDate, b.endDate, -1)
      break
  }
  // Départage stable et déterministe.
  return result !== 0 ? result : nameCollator.compare(a.name, b.name) || a.id.localeCompare(b.id)
}

export interface ChantierViewResult<T> {
  items: T[]
  /** Compteurs par état, après recherche + filtres complémentaires (sans le filtre d'état). */
  counts: Record<ChantierStateFilter, number>
}

/** Applique le pipeline complet. Ne modifie jamais le tableau source. */
export function applyChantierView<T extends FilterableChantier>(
  chantiers: readonly T[],
  query: ChantierViewQuery
): ChantierViewResult<T> {
  const counts: Record<ChantierStateFilter, number> = {
    active: 0,
    unassigned: 0,
    planned: 0,
    done: 0,
    all: 0,
  }
  const items: T[] = []

  for (const c of chantiers) {
    if (!matchesSearch(c, query.search)) continue
    if (!matchesComplementaryFilters(c, query.filters)) continue
    for (const state of CHANTIER_STATE_FILTERS) {
      if (matchesState(c, state)) counts[state]++
    }
    if (matchesState(c, query.state)) items.push(c)
  }

  items.sort((a, b) => compareChantiers(a, b, query.sort))
  return { items, counts }
}

/** Même règle que ChantiersMap (`c.latitude && c.longitude`) — lecture seule, aucune déduction. */
export function hasMapCoordinates(c: { latitude: number | null; longitude: number | null }): boolean {
  return Boolean(c.latitude && c.longitude)
}

/**
 * Carte d'un onglet filtré dont aucun chantier n'est géolocalisé → état vide contextuel.
 * « Tous » garde l'état vide natif de la carte ; un onglet vide garde l'état vide de la vue.
 */
export function shouldShowMapEmptyState(
  chantiers: readonly { latitude: number | null; longitude: number | null }[],
  state: ChantierStateFilter
): boolean {
  return state !== "all" && chantiers.length > 0 && !chantiers.some(hasMapCoordinates)
}

const STATE_NOUNS: Record<ChantierStateFilter, { one: string; many: string }> = {
  active: { one: "chantier actif", many: "chantiers actifs" },
  unassigned: { one: "chantier à affecter", many: "chantiers à affecter" },
  planned: { one: "chantier planifié", many: "chantiers planifiés" },
  done: { one: "chantier terminé", many: "chantiers terminés" },
  all: { one: "chantier", many: "chantiers" },
}

export function mapEmptyStateMessage(state: ChantierStateFilter, count: number): string {
  const nouns = STATE_NOUNS[state]
  return count === 1
    ? `Aucun chantier géolocalisé : le ${nouns.one} n'a pas de coordonnées.`
    : `Aucun chantier géolocalisé parmi les ${count} ${nouns.many}.`
}

/**
 * Clé d'identité de l'ENSEMBLE affiché (indépendante de l'ordre) :
 * un changement de tri seul ne recrée pas la carte ; un changement d'ensemble, si.
 */
export function buildChantierSetKey(chantiers: readonly Pick<FilterableChantier, "id">[]): string {
  return chantiers
    .map((c) => c.id)
    .sort()
    .join(",")
}

/**
 * Badge de statut seulement s'il apporte une information que l'onglet ne donne pas déjà
 * (ex. « Prolongé » dans Actifs, « Décalé » dans Planifiés, tout dans « Tous »).
 */
export function shouldShowStatusBadge(status: string, state: ChantierStateFilter): boolean {
  switch (state) {
    case "active":
      return status !== "IN_PROGRESS"
    case "planned":
    case "unassigned":
      return status !== "PLANNED"
    case "done":
      return false
    case "all":
      return true
  }
}

export interface FilterOption {
  id: string
  label: string
}

/** Options client dérivées des chantiers déjà autorisés (inclut les clients inactifs historiques). */
export function buildClientOptions(
  chantiers: readonly Pick<FilterableChantier, "clientId" | "client">[]
): FilterOption[] {
  const byId = new Map<string, string>()
  for (const c of chantiers) {
    if (!byId.has(c.clientId)) byId.set(c.clientId, c.client.name)
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => nameCollator.compare(a.label, b.label))
}

export interface EmployeeAssignmentRow {
  employeeId: string
  employee: { companyId: string; firstName: string; lastName: string }
  assignment: { worksiteId: string }
}

/**
 * Index « personnel affecté » — défense en profondeur : toute ligne dont l'employé
 * n'appartient pas au tenant courant est ignorée, même si la requête est déjà scopée.
 */
export function buildPersonnelIndex(
  rows: readonly EmployeeAssignmentRow[],
  companyId: string,
  allowedWorksiteIds: ReadonlySet<string>
): { employeeIdsByWorksite: Map<string, string[]>; personnelOptions: FilterOption[] } {
  const perWorksite = new Map<string, Set<string>>()
  const names = new Map<string, string>()

  for (const row of rows) {
    if (row.employee.companyId !== companyId) continue
    if (!allowedWorksiteIds.has(row.assignment.worksiteId)) continue
    let set = perWorksite.get(row.assignment.worksiteId)
    if (!set) {
      set = new Set()
      perWorksite.set(row.assignment.worksiteId, set)
    }
    set.add(row.employeeId)
    if (!names.has(row.employeeId)) {
      names.set(row.employeeId, `${row.employee.firstName} ${row.employee.lastName}`.trim())
    }
  }

  const employeeIdsByWorksite = new Map<string, string[]>()
  for (const [worksiteId, set] of perWorksite) employeeIdsByWorksite.set(worksiteId, [...set])

  const personnelOptions = [...names.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => nameCollator.compare(a.label, b.label))

  return { employeeIdsByWorksite, personnelOptions }
}
