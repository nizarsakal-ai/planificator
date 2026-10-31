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
  { id: "terrain", label: "Chantiers & terrain", icon: HardHat, hrefs: ["/chantiers", "/photos-engins", "/vehicules", "/logements"] },
  { id: "planning", label: "Planning", icon: CalendarDays, hrefs: ["/planning", "/planning/moi", "/planning/calendrier", "/planning/gantt", "/planning/personnel"] },
  {
    id: "rh", label: "Équipes & RH", icon: Users,
    hrefs: ["/employes", "/equipes", "/planning/equipe", "/absences", "/mes-absences", "/pointages", "/pointage", "/notes-de-frais", "/mes-notes-de-frais"],
  },
  { id: "commercial", label: "Commercial", icon: Handshake, hrefs: ["/clients", "/consultations", "/devis", "/articles"] },
  { id: "finance", label: "Finance", icon: Calculator, hrefs: ["/factures", "/comptabilite", "/factures-fournisseurs"] },
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

const CATEGORY_BY_HREF: ReadonlyMap<string, { id: NavCategoryId; rank: number }> = new Map(
  NAV_CATEGORY_DEFINITIONS.flatMap((category) => category.hrefs.map((href, rank) => [href, { id: category.id, rank }] as const)),
)

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
