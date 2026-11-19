/**
 * Navigation Planificator — regroupement PAR CATÉGORIES (Sidebar desktop + MobileNav).
 *
 * S'applique APRÈS la composition existante (`getNavItems(role)` puis les drapeaux serveur `with…NavItem`) : le
 * regroupement ne crée, ne retire, ne renomme ni ne réordonne aucune autorisation. Chaque entrée composée se retrouve
 * exactement une fois — dans une catégorie, dans le pied (« Mon profil ») ou, si son href n'est pas cartographié,
 * dans « Autres » (jamais perdue). Aucune catégorie vide n'est produite.
 * La visibilité dans le menu n'est PAS une autorisation : chaque page applique ses propres contrôles serveur.
 */
import type { ElementType } from "react"
import { Calculator, CalendarDays, Ellipsis, HardHat, Handshake, LayoutDashboard, Settings, Users } from "lucide-react"
import type { NavItem } from "@/lib/navigation/nav-config"

export type NavCategoryId = "pilotage" | "terrain" | "planning" | "rh" | "commercial" | "finance" | "administration" | "autres"

interface NavCategoryDefinition {
  id: NavCategoryId
  label: string
  icon: ElementType
  /** Href rattachés à la catégorie, dans l'ordre d'affichage (inclut les variantes EMPLOYEE / TEAM_LEADER). */
  hrefs: readonly string[]
}

/** Cartographie validée (visuel « sidebar par catégories »), dans l'ordre d'affichage des catégories. */
export const NAV_CATEGORY_DEFINITIONS: readonly NavCategoryDefinition[] = [
  { id: "pilotage", label: "Pilotage", icon: LayoutDashboard, hrefs: ["/dashboard", "/rapports"] },
  { id: "terrain", label: "Chantiers & terrain", icon: HardHat, hrefs: ["/chantiers", "/photos-engins", "/vehicules", "/stock", "/achats", "/materiel", "/logements"] },
  { id: "planning", label: "Planning", icon: CalendarDays, hrefs: ["/planning", "/planning/moi", "/planning/calendrier", "/planning/gantt", "/planning/personnel"] },
  {
    id: "rh", label: "Équipes & RH", icon: Users,
    hrefs: ["/mes-documents", "/rh/documents", "/employes", "/equipes", "/planning/equipe", "/absences", "/mes-absences", "/pointages", "/pointage", "/notes-de-frais", "/mes-notes-de-frais"],
  },
  { id: "commercial", label: "Commercial", icon: Handshake, hrefs: ["/clients", "/consultations", "/opportunites", "/articles"] },
  { id: "finance", label: "Finance", icon: Calculator, hrefs: ["/devis", "/factures", "/factures/avoirs", "/comptabilite", "/factures-fournisseurs"] },
  { id: "administration", label: "Administration", icon: Settings, hrefs: ["/super-admin/entreprises", "/parametres"] },
]

/** Catégorie de repli : toute entrée composée dont le href n'est pas cartographié (jamais perdue). */
export const NAV_FALLBACK_CATEGORY = { id: "autres" as const, label: "Autres", icon: Ellipsis }

/** Entrées affichées dans le pied (identité), hors catégories. */
export const NAV_FOOTER_HREFS: readonly string[] = ["/profil"]

export interface NavCategory {
  id: NavCategoryId
  label: string
  icon: ElementType
  items: NavItem[]
}

export interface GroupedNav {
  categories: NavCategory[]
  footer: NavItem[]
}

/**
 * Lot E Planificator V2 : rattachements ajoutés SANS modifier les listes ci-dessus (la liste « commercial » est figée par
 * les tests de Prospection). Rang fractionnaire : « Pipeline commercial » juste après « Opportunités » (Prospection,
 * rang 2) ; « Automatisations » après « Paramètres » (rang 1). Chaque entrée n'apparaît que si son drapeau la compose.
 */
export const NAV_CATEGORY_EXTENSIONS: readonly { href: string; id: NavCategoryId; rank: number }[] = [
  { href: "/crm/opportunites", id: "commercial", rank: 2.5 },
  { href: "/automatisations", id: "administration", rank: 1.5 },
]

/**
 * Lot F Planificator V2 : rattachements ajoutés de même, SANS modifier les listes ni les extensions du lot E.
 * « Assistant » dans Pilotage, après « Rapports » (rang 1) ; « Connecteurs » dans Administration, après
 * « Automatisations » (rang 1,5). Chaque entrée n'apparaît que si son drapeau la compose.
 */
export const NAV_CATEGORY_EXTENSIONS_LOT_F: readonly { href: string; id: NavCategoryId; rank: number }[] = [
  { href: "/assistant", id: "pilotage", rank: 2 },
  { href: "/connecteurs", id: "administration", rank: 1.75 },
]

/**
 * Lot G Planificator V2 : rattachement distinct (la liste du lot E est figée par ses tests). « Document Studio » dans
 * Administration, après « Automatisations » (rang 1,5). N'apparaît que si son drapeau le compose.
 */
export const NAV_CATEGORY_EXTENSIONS_LOT_G: readonly { href: string; id: NavCategoryId; rank: number }[] = [
  { href: "/studio-documents", id: "administration", rank: 2.5 },
]

/**
 * Lot H Planificator V2 : rattachement distinct (la liste du lot E et les listes de main restent figées par leurs tests).
 * « Pré-paie » dans Équipes & RH, juste après « Pointages » (rang 7) et avant « Pointage » (rang 8). N'apparaît que si son
 * drapeau la compose.
 */
export const NAV_CATEGORY_EXTENSIONS_LOT_H: readonly { href: string; id: NavCategoryId; rank: number }[] = [
  { href: "/pre-paie", id: "rh", rank: 7.5 },
]

/**
 * Lot I Planificator V2 : rattachements distincts (la liste du lot E et les listes de main restent figées par leurs
 * tests). « Marketing » puis « Boutique » dans Commercial, après « Articles » (rang 3). N'apparaissent que si leur
 * drapeau les compose.
 */
export const NAV_CATEGORY_EXTENSIONS_LOT_I: readonly { href: string; id: NavCategoryId; rank: number }[] = [
  { href: "/marketing", id: "commercial", rank: 3.5 },
  { href: "/boutique", id: "commercial", rank: 3.6 },
]

// Intégration FGHI : chaque extension reste distincte et inchangée ; aucun href partagé entre deux extensions (vérifié
// par tests/integration/fghi-interactions.test.ts).
const CATEGORY_BY_HREF: ReadonlyMap<string, { id: NavCategoryId; rank: number }> = new Map([
  ...NAV_CATEGORY_DEFINITIONS.flatMap((category) => category.hrefs.map((href, rank) => [href, { id: category.id, rank }] as const)),
  ...NAV_CATEGORY_EXTENSIONS.map((e) => [e.href, { id: e.id, rank: e.rank }] as const),
  ...NAV_CATEGORY_EXTENSIONS_LOT_F.map((e) => [e.href, { id: e.id, rank: e.rank }] as const),
  ...NAV_CATEGORY_EXTENSIONS_LOT_G.map((e) => [e.href, { id: e.id, rank: e.rank }] as const),
  ...NAV_CATEGORY_EXTENSIONS_LOT_H.map((e) => [e.href, { id: e.id, rank: e.rank }] as const),
  ...NAV_CATEGORY_EXTENSIONS_LOT_I.map((e) => [e.href, { id: e.id, rank: e.rank }] as const),
])

/** Catégorie d'un href (cartographie exacte) ; `null` pour une entrée du pied ; « autres » si inconnu. */
export function navCategoryOf(href: string): NavCategoryId | null {
  if (NAV_FOOTER_HREFS.includes(href)) return null
  return CATEGORY_BY_HREF.get(href)?.id ?? NAV_FALLBACK_CATEGORY.id
}

/**
 * Regroupe des entrées DÉJÀ composées. Catégories dans l'ordre fixe, entrées dans l'ordre de la cartographie, entrées
 * inconnues dans « Autres » dans leur ordre d'origine. Catégories vides omises. Aucun ajout, aucune perte, aucun doublon.
 */
export function groupNavItems(items: readonly NavItem[]): GroupedNav {
  const footer: NavItem[] = []
  const buckets = new Map<NavCategoryId, Array<{ item: NavItem; rank: number; index: number }>>()
  items.forEach((item, index) => {
    const id = navCategoryOf(item.href)
    if (id === null) { footer.push(item); return }
    const rank = CATEGORY_BY_HREF.get(item.href)?.rank ?? Number.MAX_SAFE_INTEGER
    const bucket = buckets.get(id) ?? []
    bucket.push({ item, rank, index })
    buckets.set(id, bucket)
  })
  const order = [...NAV_CATEGORY_DEFINITIONS, NAV_FALLBACK_CATEGORY]
  const categories = order.flatMap((definition) => {
    const bucket = buckets.get(definition.id)
    if (!bucket || bucket.length === 0) return []
    bucket.sort((a, b) => a.rank - b.rank || a.index - b.index)
    return [{ id: definition.id, label: definition.label, icon: definition.icon, items: bucket.map((entry) => entry.item) }]
  })
  return { categories, footer }
}

/** Catégorie qui contient l'entrée active (règle d'activation existante : la plus spécifique) ; `null` sinon ou si pied. */
export function getActiveNavCategoryId(grouped: GroupedNav, activeHref: string | null): NavCategoryId | null {
  if (activeHref === null) return null
  return grouped.categories.find((category) => category.items.some((item) => item.href === activeHref))?.id ?? null
}
