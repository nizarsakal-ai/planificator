/**
 * Page Équipes V2 — logique pure d'affichage (aucune mutation, aucun accès DB).
 *
 * Pipeline : données tenant (serveur) → projection défensive → onglet → recherche → filtres → tri.
 * Aucune donnée n'est inventée : la « capacité » n'existe pas en base, seul un repère
 * recommandé (5–6 membres) est présenté comme tel.
 */

// ─── Journée de référence (Europe/Paris) ─────────────────────────────────────

const PARIS_TZ = "Europe/Paris"

/** Date civile Europe/Paris (AAAA-MM-JJ), indépendante du fuseau du serveur. */
export function parisDateKey(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

/**
 * Valeur à comparer à `Assignment.date` (@db.Date) : minuit UTC du jour civil parisien.
 * Prisma lit/écrit les colonnes DATE comme minuit UTC de la date.
 */
export function parisTodayAsDbDate(now: Date): Date {
  return new Date(`${parisDateKey(now)}T00:00:00.000Z`)
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Décalage d'une valeur @db.Date (minuit UTC) — arithmétique UTC pure, sans effet d'heure d'été. */
export function addDbDays(dbDate: Date, days: number): Date {
  return new Date(dbDate.getTime() + days * DAY_MS)
}

/** Fenêtre de lecture des affectations : aujourd'hui (Paris) → +30 jours inclus. */
export const UPCOMING_WINDOW_DAYS = 30

// ─── Types projetés ──────────────────────────────────────────────────────────

export interface EquipePerson {
  id: string
  firstName: string
  lastName: string
}

export interface EquipeMember extends EquipePerson {
  avatarUrl: string | null
  /** Employee.active — un employé désactivé n'est pas compté dans « Membres affectés ». */
  active: boolean
}

export interface EquipeTruck {
  id: string
  matricule: string
  marque: string | null
  modele?: string | null
}

export interface EquipeViewItem {
  id: string
  name: string
  color: string | null
  active: boolean
  leader: EquipePerson
  /** Appartenances actives (leftAt = null), ordre d'arrivée. */
  members: EquipeMember[]
  truck: EquipeTruck | null
  /** Chantier d'une affectation CONFIRMED aujourd'hui (Europe/Paris), sinon null. */
  currentWorksite: EquipeWorksite | null
}

/** Coordonnées = celles du chantier (Worksite), jamais d'une équipe, d'un logement ou d'une personne. */
export interface EquipeWorksite {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
}

/** Repère de présentation — PAS une capacité configurée en base. */
export const RECOMMENDED_TEAM_SIZE = { min: 5, max: 6 } as const

// ─── Projection serveur → client (défense en profondeur tenant) ──────────────

export interface EquipeRow {
  id: string
  companyId: string
  name: string
  color: string | null
  active: boolean
  leader: EquipePerson & { companyId: string }
  members: { employee: EquipeMember & { companyId: string } }[]
  truck: (EquipeTruck & { companyId: string }) | null
}

export interface TodayAssignmentRow {
  teamId: string | null
  status: string
  worksite: EquipeWorksite & { companyId: string }
}

/** Affectation lue sur la fenêtre [aujourd'hui, +30 j] (une seule requête groupée). */
export interface AssignmentWindowRow extends TodayAssignmentRow {
  date: Date
}

/** Affectations d'un jour donné (@db.Date) parmi celles de la fenêtre. */
export function assignmentsOnDbDate<T extends { date: Date }>(rows: readonly T[], day: Date): T[] {
  return rows.filter((r) => r.date.getTime() === day.getTime())
}

/**
 * Projection : ignore toute équipe, personne, véhicule ou chantier d'un autre tenant,
 * et toute affectation non CONFIRMED (PENDING / REFUSED ne sont pas des interventions).
 */
export function toEquipeViewItems(
  rows: readonly EquipeRow[],
  todayAssignments: readonly TodayAssignmentRow[],
  companyId: string
): EquipeViewItem[] {
  const worksiteByTeam = new Map<string, EquipeWorksite>()
  for (const a of todayAssignments) {
    if (!a.teamId || a.status !== "CONFIRMED" || a.worksite.companyId !== companyId) continue
    if (!worksiteByTeam.has(a.teamId)) worksiteByTeam.set(a.teamId, toWorksite(a.worksite))
  }

  const items: EquipeViewItem[] = []
  for (const r of rows) {
    if (r.companyId !== companyId || r.leader.companyId !== companyId) continue
    items.push({
      id: r.id,
      name: r.name,
      color: r.color,
      active: r.active,
      leader: { id: r.leader.id, firstName: r.leader.firstName, lastName: r.leader.lastName },
      members: r.members
        .filter((m) => m.employee.companyId === companyId)
        .map(({ employee: e }) => ({
          id: e.id,
          firstName: e.firstName,
          lastName: e.lastName,
          avatarUrl: e.avatarUrl,
          active: e.active,
        })),
      truck:
        r.truck && r.truck.companyId === companyId
          ? { id: r.truck.id, matricule: r.truck.matricule, marque: r.truck.marque, modele: r.truck.modele ?? null }
          : null,
      currentWorksite: worksiteByTeam.get(r.id) ?? null,
    })
  }
  return items
}

function toWorksite(w: EquipeWorksite): EquipeWorksite {
  return { id: w.id, name: w.name, latitude: w.latitude, longitude: w.longitude }
}

// ─── KPI ─────────────────────────────────────────────────────────────────────

export interface EquipeStats {
  activeTeams: number
  totalTeams: number
  /** Employés ACTIFS DISTINCTS avec une appartenance active dans une équipe active. */
  assignedMembers: number
  /** Employés actifs sans appartenance active à une équipe active (compté côté serveur). */
  employeesWithoutTeam: number
  /** Équipes actives avec véhicule. */
  teamsWithVehicle: number
}

export function computeEquipeStats(items: readonly EquipeViewItem[], employeesWithoutTeam: number): EquipeStats {
  const active = items.filter((t) => t.active)
  const distinct = new Set<string>()
  for (const t of active) for (const m of t.members) if (m.active) distinct.add(m.id)
  return {
    activeTeams: active.length,
    totalTeams: items.length,
    assignedMembers: distinct.size,
    employeesWithoutTeam,
    teamsWithVehicle: active.filter((t) => t.truck !== null).length,
  }
}

// ─── Onglets, recherche, filtres, tri ────────────────────────────────────────

export type EquipeTab = "all" | "active" | "inIntervention" | "withoutVehicle" | "archived"

export const EQUIPE_TABS: readonly EquipeTab[] = ["all", "active", "inIntervention", "withoutVehicle", "archived"]
export const DEFAULT_EQUIPE_TAB: EquipeTab = "all"

export const EQUIPE_TAB_LABELS: Record<EquipeTab, string> = {
  all: "Toutes",
  active: "Actives",
  inIntervention: "En intervention",
  withoutVehicle: "Sans véhicule",
  archived: "Archivées",
}

export function matchesEquipeTab(t: EquipeViewItem, tab: EquipeTab): boolean {
  switch (tab) {
    case "all":
      return true
    case "active":
      return t.active
    case "inIntervention":
      return t.active && t.currentWorksite !== null
    case "withoutVehicle":
      return isActiveWithoutVehicle(t)
    case "archived":
      return !t.active
  }
}

export type VehicleFilter = "all" | "with" | "without"

/** Définition unique de « Sans véhicule » (onglet, compteur, filtre) : équipe ACTIVE sans véhicule. */
export function isActiveWithoutVehicle(t: EquipeViewItem): boolean {
  return t.active && t.truck === null
}

/** « Avec véhicule » suit la même règle : équipe ACTIVE avec véhicule (archivées → onglet Archivées). */
export function isActiveWithVehicle(t: EquipeViewItem): boolean {
  return t.active && t.truck !== null
}

export type EquipeSort = "name-asc" | "name-desc" | "members-asc" | "members-desc"
export const DEFAULT_EQUIPE_SORT: EquipeSort = "name-asc"
export const EQUIPE_SORT_LABELS: Record<EquipeSort, string> = {
  "name-asc": "Nom : A → Z",
  "name-desc": "Nom : Z → A",
  "members-asc": "Membres : croissant",
  "members-desc": "Membres : décroissant",
}

export interface EquipeQuery {
  tab: EquipeTab
  search: string
  vehicle: VehicleFilter
  sort: EquipeSort
}

export function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
}

/** Nom d'équipe, chef, membres — tous les termes doivent correspondre (ET). */
export function matchesEquipeSearch(t: EquipeViewItem, search: string): boolean {
  const terms = normalizeText(search).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = normalizeText(
    [
      t.name,
      `${t.leader.firstName} ${t.leader.lastName}`,
      ...t.members.map((m) => `${m.firstName} ${m.lastName}`),
    ].join(" \u0000 ")
  )
  return terms.every((term) => haystack.includes(term))
}

export function matchesVehicleFilter(t: EquipeViewItem, vehicle: VehicleFilter): boolean {
  if (vehicle === "with") return isActiveWithVehicle(t)
  if (vehicle === "without") return isActiveWithoutVehicle(t)
  return true
}

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true })

export function compareEquipes(a: EquipeViewItem, b: EquipeViewItem, sort: EquipeSort): number {
  const byName = collator.compare(a.name, b.name)
  let result: number
  switch (sort) {
    case "name-asc":
      result = byName
      break
    case "name-desc":
      result = -byName
      break
    case "members-asc":
      result = a.members.length - b.members.length || byName
      break
    case "members-desc":
      result = b.members.length - a.members.length || byName
      break
  }
  return result || a.id.localeCompare(b.id)
}

export interface EquipeViewResult {
  items: EquipeViewItem[]
  /** Compteurs d'onglets après recherche + filtre véhicule. */
  counts: Record<EquipeTab, number>
}

export function applyEquipeView(items: readonly EquipeViewItem[], query: EquipeQuery): EquipeViewResult {
  const counts: Record<EquipeTab, number> = { all: 0, active: 0, inIntervention: 0, withoutVehicle: 0, archived: 0 }
  const out: EquipeViewItem[] = []
  for (const t of items) {
    if (!matchesEquipeSearch(t, query.search)) continue
    if (!matchesVehicleFilter(t, query.vehicle)) continue
    for (const tab of EQUIPE_TABS) if (matchesEquipeTab(t, tab)) counts[tab]++
    if (matchesEquipeTab(t, query.tab)) out.push(t)
  }
  out.sort((a, b) => compareEquipes(a, b, query.sort))
  return { items: out, counts }
}

// ─── Présentation ────────────────────────────────────────────────────────────

/** Avatars visibles (limite) + reste « +N ». */
export function splitAvatars<T>(members: readonly T[], max = 4): { visible: T[]; overflow: number } {
  return { visible: members.slice(0, max), overflow: Math.max(0, members.length - max) }
}

/** Libellé de repère : jamais présenté comme une capacité configurée. */
export function teamSizeHint(count: number): { label: string; ratio: number; tone: "under" | "ok" | "over" } {
  const { min, max } = RECOMMENDED_TEAM_SIZE
  return {
    label: `Membres : ${count} · recommandation ${min}–${max}`,
    ratio: Math.min(count / max, 1),
    tone: count < min ? "under" : count > max ? "over" : "ok",
  }
}

// ─── Menu « ••• » ────────────────────────────────────────────────────────────

export type EquipeMenuAction = "view" | "edit" | "members" | "vehicle" | "archive" | "restore"

/**
 * Actions proposées. `canManage` est calculé côté serveur avec les rôles exacts de requireAdmin
 * et de PATCH/POST /api/trucks : aucune action que le serveur refuserait n'est affichée.
 * Jamais de suppression ni d'affectation de chantier.
 */
export function getEquipeMenuActions(active: boolean, canManage: boolean): EquipeMenuAction[] {
  if (!canManage) return ["view"]
  return active ? ["view", "edit", "members", "vehicle", "archive"] : ["view", "edit", "restore"]
}

// ─── Panneau droit (PR B) ────────────────────────────────────────────────────

/** Couleur unique « Équipe en intervention » (marqueurs de carte et légende). */
export const INTERVENTION_MARKER_COLOR = "#10b981"

export interface EquipeRef {
  id: string
  name: string
  color: string | null
}

const toRef = (t: EquipeViewItem): EquipeRef => ({ id: t.id, name: t.name, color: t.color })

export interface CurrentIntervention {
  team: EquipeRef
  worksite: EquipeWorksite
}

/** Intervention actuelle = équipe ACTIVE + affectation CONFIRMED aujourd'hui (Europe/Paris). Même règle que l'onglet. */
export function getCurrentInterventions(items: readonly EquipeViewItem[]): CurrentIntervention[] {
  return items
    .filter((t) => matchesEquipeTab(t, "inIntervention"))
    .sort((a, b) => compareEquipes(a, b, "name-asc"))
    .map((t) => ({ team: toRef(t), worksite: t.currentWorksite! }))
}

/** Coordonnées exploitables : nombres finis dans les bornes WGS84. Rien n'est déduit ni géocodé. */
export function hasValidCoordinates(w: { latitude: number | null; longitude: number | null }): boolean {
  const { latitude: lat, longitude: lng } = w
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  )
}

/** Un marqueur = un point ; plusieurs chantiers / équipes au même point sont regroupés (aucun décalage inventé). */
export interface InterventionMarker {
  key: string
  latitude: number
  longitude: number
  sites: { worksite: { id: string; name: string }; teams: EquipeRef[] }[]
  teamCount: number
}

export interface InterventionMapData {
  markers: InterventionMarker[]
  /** Équipes en intervention dont le chantier n'a pas de coordonnées. */
  unlocalized: CurrentIntervention[]
}

export function buildInterventionMap(current: readonly CurrentIntervention[]): InterventionMapData {
  const byPoint = new Map<string, InterventionMarker>()
  const unlocalized: CurrentIntervention[] = []
  for (const c of current) {
    if (!hasValidCoordinates(c.worksite)) {
      unlocalized.push(c)
      continue
    }
    const lat = c.worksite.latitude!
    const lng = c.worksite.longitude!
    const key = `${lat},${lng}`
    let marker = byPoint.get(key)
    if (!marker) {
      marker = { key, latitude: lat, longitude: lng, sites: [], teamCount: 0 }
      byPoint.set(key, marker)
    }
    let site = marker.sites.find((s) => s.worksite.id === c.worksite.id)
    if (!site) {
      site = { worksite: { id: c.worksite.id, name: c.worksite.name }, teams: [] }
      marker.sites.push(site)
    }
    site.teams.push(c.team)
    marker.teamCount++
  }
  return { markers: [...byPoint.values()], unlocalized }
}

export interface UpcomingIntervention {
  team: EquipeRef
  worksite: { id: string; name: string }
  /** Valeur @db.Date (minuit UTC). */
  date: Date
}

export const UPCOMING_LIMIT = 3

/**
 * Prochaine intervention de chaque équipe ACTIVE du tenant : date > aujourd'hui (Paris), CONFIRMED.
 * Une ligne par équipe (la plus proche), triées par date puis nom ; `total` = nombre d'équipes concernées.
 */
export function getUpcomingInterventions(
  rows: readonly AssignmentWindowRow[],
  items: readonly EquipeViewItem[],
  companyId: string,
  today: Date,
  limit = UPCOMING_LIMIT
): { items: UpcomingIntervention[]; total: number } {
  const activeTeams = new Map(items.filter((t) => t.active).map((t) => [t.id, t]))
  const nextByTeam = new Map<string, UpcomingIntervention>()
  for (const r of rows) {
    if (!r.teamId || r.status !== "CONFIRMED" || r.worksite.companyId !== companyId) continue
    if (r.date.getTime() <= today.getTime()) continue
    const team = activeTeams.get(r.teamId)
    if (!team) continue
    const prev = nextByTeam.get(team.id)
    if (!prev || r.date.getTime() < prev.date.getTime()) {
      nextByTeam.set(team.id, { team: toRef(team), worksite: { id: r.worksite.id, name: r.worksite.name }, date: r.date })
    }
  }
  const all = [...nextByTeam.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || collator.compare(a.team.name, b.team.name)
  )
  return { items: all.slice(0, limit), total: all.length }
}

/** Date @db.Date lisible (fuseau UTC = la date civile stockée), ex. « mer. 8 oct. ». */
export function formatDbDate(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(date)
}

// ─── Sécurité HTML (popups Leaflet) ──────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const DEFAULT_COLOR = "#0f3460"

/** Couleur d'équipe réinjectée dans du HTML/CSS : uniquement un hexadécimal strict, sinon couleur par défaut. */
export function safeTeamColor(color: string | null): string {
  return color && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color) ? color : DEFAULT_COLOR
}

/** Contenu de popup : toutes les valeurs issues de la base sont échappées. */
export function buildMarkerPopupHtml(marker: InterventionMarker): string {
  const sites = marker.sites
    .map((s) => {
      const teams = s.teams
        .map(
          (t) =>
            `<li style="display:flex;align-items:center;gap:6px;margin-top:2px">` +
            `<span style="width:8px;height:8px;border-radius:9999px;background:${safeTeamColor(t.color)}"></span>` +
            `${escapeHtml(t.name)}</li>`
        )
        .join("")
      return (
        `<div style="margin-bottom:4px">` +
        `<p style="font-weight:600;font-size:12px;margin:0">${escapeHtml(s.worksite.name)}</p>` +
        `<ul style="list-style:none;padding:0;margin:2px 0 0;font-size:11px;color:#475569">${teams}</ul>` +
        `</div>`
      )
    })
    .join("")
  return `<div style="min-width:140px">${sites}</div>`
}

// ─── Actions rapides ─────────────────────────────────────────────────────────

export type QuickActionId = "newTeam" | "planning" | "worksites" | "vehicles"

export interface QuickAction {
  id: QuickActionId
  label: string
  /** null = action dans la page (dialogue Nouvelle équipe). */
  href: string | null
}

const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN"]
const TEAM_PAGE_ROLES = ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]

/**
 * Planning des équipes, selon les gardes serveur existantes :
 * /planning n'admet que ADMIN/SUPER_ADMIN ; /planning/calendrier admet aussi TEAM_LEADER.
 */
export function getPlanningHref(role: string): string {
  return ADMIN_ROLES.includes(role) ? "/planning" : "/planning/calendrier"
}

/** Calendrier des affectations (ADMIN, SUPER_ADMIN, TEAM_LEADER). */
export const UPCOMING_SEE_ALL_HREF = "/planning/calendrier"

/**
 * Actions visibles uniquement si la garde serveur de la cible admet le rôle :
 * createEquipe (requireAdmin), /planning|/planning/calendrier, /chantiers, /vehicules (ADMIN/SUPER_ADMIN).
 * Pas d'« Affectation rapide » (nécessite un nouveau workflow).
 */
export function getQuickActions(role: string): QuickAction[] {
  if (!TEAM_PAGE_ROLES.includes(role)) return []
  const actions: QuickAction[] = [
    { id: "newTeam", label: "Nouvelle équipe", href: null },
    { id: "planning", label: "Voir le planning", href: getPlanningHref(role) },
    { id: "worksites", label: "Voir les chantiers", href: "/chantiers" },
  ]
  if (ADMIN_ROLES.includes(role)) actions.push({ id: "vehicles", label: "Gérer les véhicules", href: "/vehicules" })
  return actions
}
