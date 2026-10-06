/**
 * Page Véhicules — logique pure d'affichage (aucun accès DB, aucun React, aucun effet de bord).
 *
 * Pipeline déterministe :
 *   données tenant (serveur) → onglet Actifs/Archivés/Tous → recherche → filtres → tri.
 *
 * « Archivé » est la présentation de `Truck.active = false` (V1B). Un véhicule archivé n'a jamais d'équipe ni de
 * chauffeur courants (CHECK DB V1A) : il n'est donc jamais « affecté ».
 * Les anciennes valeurs de `marque` (souvent « marque modèle ») ne sont jamais découpées : `modele` est un champ distinct,
 * complété progressivement.
 */

// ─── Identité ────────────────────────────────────────────────────────────────

export const VEHICLE_IDENTITY_FALLBACK = "Marque et modèle non renseignés"

const clean = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "")

/** `[marque, modele]` non vides joints par un espace ; null si les deux sont absents. */
export function formatVehicleIdentity(marque: string | null | undefined, modele: string | null | undefined): string | null {
  const parts = [clean(marque), clean(modele)].filter(Boolean)
  return parts.length > 0 ? parts.join(" ") : null
}

/** Libellé d'identité avec repli lisible. */
export function vehicleIdentityLabel(marque: string | null | undefined, modele: string | null | undefined): string {
  return formatVehicleIdentity(marque, modele) ?? VEHICLE_IDENTITY_FALLBACK
}

/** Libellé de sélecteur : « AB-123-CD — VW Crafter » ou « AB-123-CD ». */
export function vehicleOptionLabel(v: { matricule: string; marque?: string | null; modele?: string | null }): string {
  const identity = formatVehicleIdentity(v.marque, v.modele)
  return identity ? `${v.matricule} — ${identity}` : v.matricule
}

// ─── Formulaire ──────────────────────────────────────────────────────────────

export interface VehicleFormValues {
  matricule: string
  marque: string
  modele: string
}

export const EMPTY_VEHICLE_FORM: VehicleFormValues = { matricule: "", marque: "", modele: "" }

export function vehicleToFormValues(v: { matricule: string; marque: string | null; modele: string | null }): VehicleFormValues {
  return { matricule: v.matricule, marque: v.marque ?? "", modele: v.modele ?? "" }
}

/** Corps POST / PATCH /api/trucks : valeurs trimées (le serveur normalise ensuite, vide → null). */
export function toTruckPayload(values: VehicleFormValues): { matricule: string; marque: string; modele: string } {
  return { matricule: values.matricule.trim(), marque: values.marque.trim(), modele: values.modele.trim() }
}

export function isVehicleFormSubmittable(values: VehicleFormValues): boolean {
  return values.matricule.trim().length > 0
}

// ─── Modèle de vue ───────────────────────────────────────────────────────────

export type VehicleHistoryReason = "CREATED" | "REASSIGNED" | "DISPLACED" | "ARCHIVED" | "RESTORED" | "BACKFILL"

export const VEHICLE_HISTORY_REASON_LABELS: Record<VehicleHistoryReason, string> = {
  CREATED: "Création",
  REASSIGNED: "Réaffectation",
  DISPLACED: "Déplacement",
  ARCHIVED: "Archivage",
  RESTORED: "Restauration",
  BACKFILL: "Historique initial",
}

/** Libellé utilisateur ; jamais le nom technique brut lorsqu'un mapping existe. */
export function historyReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null
  return Object.prototype.hasOwnProperty.call(VEHICLE_HISTORY_REASON_LABELS, reason)
    ? VEHICLE_HISTORY_REASON_LABELS[reason as VehicleHistoryReason]
    : null
}

export const VEHICLE_HISTORY_LIMIT = 20

/**
 * Le serveur charge LIMIT + 1 périodes : la présence d'un élément en plus prouve qu'il existe des périodes
 * plus anciennes. On n'affiche que LIMIT éléments et on ne signale la troncature que dans ce cas.
 */
export function limitHistory<T>(rows: readonly T[], limit: number = VEHICLE_HISTORY_LIMIT): { entries: T[]; truncated: boolean } {
  return { entries: rows.slice(0, limit), truncated: rows.length > limit }
}

export interface VehicleHistoryEntry {
  id: string
  chauffeurName: string | null
  teamName: string | null
  reason: string | null
  startedAt: string
  endedAt: string | null
}

export interface VehicleTeamRef {
  id: string
  name: string
  color: string | null
}

export interface VehicleDriverRef {
  id: string
  firstName: string
  lastName: string
}

export interface VehicleViewItem {
  id: string
  matricule: string
  marque: string | null
  modele: string | null
  active: boolean
  archivedAt: string | null
  createdAt: string
  team: VehicleTeamRef | null
  chauffeur: VehicleDriverRef | null
  history: VehicleHistoryEntry[]
  /** Vrai si des périodes plus anciennes que celles affichées existent. */
  historyTruncated: boolean
}

// ─── Statistiques et onglets ─────────────────────────────────────────────────

export type VehicleTab = "active" | "archived" | "all"
export const VEHICLE_TABS: readonly VehicleTab[] = ["active", "archived", "all"] as const
export const DEFAULT_VEHICLE_TAB: VehicleTab = "active"
export const VEHICLE_TAB_LABELS: Record<VehicleTab, string> = { active: "Actifs", archived: "Archivés", all: "Tous" }

/** Affecté : véhicule actif avec au moins une affectation courante (équipe OU chauffeur). */
export const isAssigned = (v: VehicleViewItem): boolean => v.active && (v.team !== null || v.chauffeur !== null)
/** Sans équipe : véhicule actif sans équipe courante. */
export const isWithoutTeam = (v: VehicleViewItem): boolean => v.active && v.team === null

/**
 * Badge d'affectation de la carte : utilise la MÊME définition que le KPI « Affectés » et le filtre (isAssigned).
 * Équipe courante → son nom ; chauffeur seul → « Affecté » ; ni l'un ni l'autre → « Non affecté » ;
 * véhicule archivé → « Archivé » (jamais présenté comme affecté).
 */
export function vehicleAssignmentBadge(v: VehicleViewItem): { label: string; assigned: boolean } {
  if (!v.active) return { label: "Archivé", assigned: false }
  if (v.team) return { label: v.team.name, assigned: true }
  return isAssigned(v) ? { label: "Affecté", assigned: true } : { label: "Non affecté", assigned: false }
}

export interface VehicleStats {
  total: number
  active: number
  assigned: number
  withoutTeam: number
  archived: number
}

export function computeVehicleStats(items: readonly VehicleViewItem[]): VehicleStats {
  return {
    total: items.length,
    active: items.filter((v) => v.active).length,
    assigned: items.filter(isAssigned).length,
    withoutTeam: items.filter(isWithoutTeam).length,
    archived: items.filter((v) => !v.active).length,
  }
}

export function matchesTab(v: VehicleViewItem, tab: VehicleTab): boolean {
  return tab === "all" ? true : tab === "active" ? v.active : !v.active
}

// ─── Recherche ───────────────────────────────────────────────────────────────

/** Minuscules, sans accents, espaces réduits. */
export function normalizeSearch(input: string | null | undefined): string {
  return (input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function haystack(v: VehicleViewItem): string {
  const driver = v.chauffeur ? `${v.chauffeur.firstName} ${v.chauffeur.lastName} ${v.chauffeur.lastName} ${v.chauffeur.firstName}` : ""
  return normalizeSearch(
    [v.matricule, v.marque, v.modele, formatVehicleIdentity(v.marque, v.modele), v.team?.name, driver].filter(Boolean).join(" ")
  )
}

/** Tous les mots saisis doivent apparaître (matricule, marque, modèle, équipe, chauffeur). */
export function matchesSearch(v: VehicleViewItem, search: string): boolean {
  const tokens = normalizeSearch(search).split(" ").filter(Boolean)
  if (tokens.length === 0) return true
  const h = haystack(v)
  return tokens.every((t) => h.includes(t))
}

// ─── Filtres et tri ──────────────────────────────────────────────────────────

export const NO_TEAM = "__none__"
export const NO_DRIVER = "__none__"

/** Filtre d'affectation : tous / affectés / non affectés. */
export type VehicleAssignmentFilter = "all" | "assigned" | "unassigned"
export const VEHICLE_ASSIGNMENT_FILTERS: readonly VehicleAssignmentFilter[] = ["all", "assigned", "unassigned"] as const
export const VEHICLE_ASSIGNMENT_LABELS: Record<VehicleAssignmentFilter, string> = {
  all: "Toutes",
  assigned: "Affectés",
  unassigned: "Non affectés",
}

export interface VehicleFilters {
  /** Id d'équipe, NO_TEAM pour « Sans équipe », null = toutes. */
  teamId: string | null
  /** Id de chauffeur, NO_DRIVER pour « Sans chauffeur », null = tous. */
  chauffeurId: string | null
  assignment: VehicleAssignmentFilter
}

export const DEFAULT_VEHICLE_FILTERS: VehicleFilters = { teamId: null, chauffeurId: null, assignment: "all" }

export function countActiveFilters(f: VehicleFilters): number {
  return (f.teamId !== null ? 1 : 0) + (f.chauffeurId !== null ? 1 : 0) + (f.assignment !== "all" ? 1 : 0)
}

export function matchesFilters(v: VehicleViewItem, f: VehicleFilters): boolean {
  if (f.teamId !== null) {
    if (f.teamId === NO_TEAM ? v.team !== null : v.team?.id !== f.teamId) return false
  }
  if (f.chauffeurId !== null) {
    if (f.chauffeurId === NO_DRIVER ? v.chauffeur !== null : v.chauffeur?.id !== f.chauffeurId) return false
  }
  if (f.assignment === "assigned" && !isAssigned(v)) return false
  if (f.assignment === "unassigned" && isAssigned(v)) return false
  return true
}

export type VehicleSort = "matricule" | "identity" | "created"
export const VEHICLE_SORTS: readonly VehicleSort[] = ["matricule", "identity", "created"] as const
export const DEFAULT_VEHICLE_SORT: VehicleSort = "matricule"
export const VEHICLE_SORT_LABELS: Record<VehicleSort, string> = {
  matricule: "Immatriculation",
  identity: "Marque / modèle",
  created: "Date de création (récents d'abord)",
}

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true })

/** Tri stable et déterministe (égalités départagées par immatriculation puis id). */
export function sortVehicles(items: readonly VehicleViewItem[], sort: VehicleSort): VehicleViewItem[] {
  const byMatricule = (a: VehicleViewItem, b: VehicleViewItem) =>
    collator.compare(a.matricule, b.matricule) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const out = [...items]
  if (sort === "identity") {
    out.sort((a, b) => {
      const ia = formatVehicleIdentity(a.marque, a.modele)
      const ib = formatVehicleIdentity(b.marque, b.modele)
      if (ia === null && ib === null) return byMatricule(a, b)
      if (ia === null) return 1 // sans identité : en fin de liste
      if (ib === null) return -1
      return collator.compare(ia, ib) || byMatricule(a, b)
    })
  } else if (sort === "created") {
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byMatricule(a, b))
  } else {
    out.sort(byMatricule)
  }
  return out
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export interface VehicleQuery {
  tab: VehicleTab
  search: string
  filters: VehicleFilters
  sort: VehicleSort
}

export const DEFAULT_VEHICLE_QUERY: VehicleQuery = {
  tab: DEFAULT_VEHICLE_TAB,
  search: "",
  filters: DEFAULT_VEHICLE_FILTERS,
  sort: DEFAULT_VEHICLE_SORT,
}

export interface VehicleViewResult {
  items: VehicleViewItem[]
  /** Compteurs d'onglets : recherche et filtres appliqués, onglet ignoré. */
  counts: Record<VehicleTab, number>
}

export function applyVehicleView(items: readonly VehicleViewItem[], q: VehicleQuery): VehicleViewResult {
  const base = items.filter((v) => matchesSearch(v, q.search) && matchesFilters(v, q.filters))
  const counts: Record<VehicleTab, number> = {
    all: base.length,
    active: base.filter((v) => v.active).length,
    archived: base.filter((v) => !v.active).length,
  }
  return { items: sortVehicles(base.filter((v) => matchesTab(v, q.tab)), q.sort), counts }
}

// ─── Options de filtre ───────────────────────────────────────────────────────

export interface VehicleFilterOption {
  id: string
  label: string
}

/** Équipes présentes sur les véhicules (courantes, y compris archivées), triées par nom. */
export function teamFilterOptions(items: readonly VehicleViewItem[]): VehicleFilterOption[] {
  const map = new Map<string, string>()
  for (const v of items) if (v.team) map.set(v.team.id, v.team.name)
  return [...map].map(([id, label]) => ({ id, label })).sort((a, b) => collator.compare(a.label, b.label))
}

/** Chauffeurs présents sur les véhicules, triés par nom. */
export function driverFilterOptions(items: readonly VehicleViewItem[]): VehicleFilterOption[] {
  const map = new Map<string, string>()
  for (const v of items) if (v.chauffeur) map.set(v.chauffeur.id, `${v.chauffeur.firstName} ${v.chauffeur.lastName}`.trim())
  return [...map].map(([id, label]) => ({ id, label })).sort((a, b) => collator.compare(a.label, b.label))
}

// ─── Accès à la page ─────────────────────────────────────────────────────────

export type VehiclesAccess = { kind: "redirect"; to: string } | { kind: "ok"; companyId: string }

/**
 * Contrôle d'accès de /vehicules (ADMIN et SUPER_ADMIN). `companyId` est null pour un SUPER_ADMIN sans entreprise :
 * aucune requête Truck n'est alors lancée (jamais `companyId: null`), redirection vers l'administration.
 */
export function resolveVehiclesAccess(
  session: { user?: { role?: string | null; companyId?: string | null } | null } | null
): VehiclesAccess {
  const user = session?.user
  if (!user) return { kind: "redirect", to: "/login" }
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") return { kind: "redirect", to: "/dashboard" }
  const companyId = typeof user.companyId === "string" ? user.companyId.trim() : ""
  if (!companyId) return { kind: "redirect", to: user.role === "SUPER_ADMIN" ? "/super-admin/entreprises" : "/dashboard" }
  return { kind: "ok", companyId }
}
