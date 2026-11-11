/**
 * Navigation Planificator — source de vérité unique (Sidebar desktop + MobileNav).
 *
 * PR1 : centralisation à comportement constant. Les listes ci-dessous reprennent
 * à l'identique les définitions qui étaient dupliquées dans Sidebar.tsx et MobileNav.tsx
 * (mêmes libellés, href, icônes, ordre, visibilité par rôle).
 *
 * La visibilité dans le menu n'est PAS une autorisation : chaque page applique
 * ses propres contrôles serveur.
 */
import type { ElementType } from "react"
import type { Role } from "@prisma/client"
import {
  LayoutDashboard,
  Building2,
  Users,
  Layers,
  UserCheck,
  HardHat,
  Calendar,
  CalendarOff,
  Settings,
  User,
  GanttChart,
  ClipboardList,
  Receipt,
  MapPin,
  CalendarDays,
  BedDouble,
  Library,
  FileText,
  Truck,
  Mail,
  Calculator,
  Camera,
  Radar,
  Boxes,
  ShoppingCart,
  Wrench,
} from "lucide-react"

export interface NavItem {
  label: string
  href: string
  icon: ElementType
  badge?: string // ex: "Bientôt"
}

const NAV_ITEMS_BY_ROLE: Partial<Record<Role, readonly NavItem[]>> = {
  SUPER_ADMIN: [
    { label: "Dashboard",        href: "/dashboard",              icon: LayoutDashboard },
    { label: "Administration",   href: "/super-admin/entreprises",icon: Building2 },
    { label: "Employés",         href: "/employes",               icon: Users },
    { label: "Équipes",          href: "/equipes",                icon: Layers },
    { label: "Véhicules",        href: "/vehicules",              icon: Truck },
    { label: "Clients",          href: "/clients",                icon: UserCheck },
    { label: "Chantiers",        href: "/chantiers",              icon: HardHat },
    { label: "Consultations",    href: "/consultations",          icon: Mail },
    { label: "Logements",        href: "/logements",              icon: BedDouble },
    { label: "Bibliothèque",     href: "/articles",               icon: Library },
    { label: "Factures",         href: "/factures",               icon: FileText },
    { label: "Planning",         href: "/planning",               icon: Calendar },
    { label: "Gantt",            href: "/planning/gantt",         icon: GanttChart },
    { label: "Calendrier",       href: "/planning/calendrier",    icon: CalendarDays },
    { label: "Personnel",        href: "/planning/personnel",     icon: Users },
    { label: "Absences",         href: "/absences",               icon: CalendarOff },
    { label: "Notes de frais",   href: "/notes-de-frais",         icon: Receipt },
    { label: "Pointages",        href: "/pointages",              icon: MapPin },
    { label: "Rapports",         href: "/rapports",               icon: ClipboardList },
    { label: "Mon profil",       href: "/profil",                 icon: User },
    { label: "Paramètres",       href: "/parametres",             icon: Settings },
  ],

  ADMIN: [
    { label: "Dashboard",        href: "/dashboard",              icon: LayoutDashboard },
    { label: "Employés",         href: "/employes",               icon: Users },
    { label: "Équipes",          href: "/equipes",                icon: Layers },
    { label: "Véhicules",        href: "/vehicules",              icon: Truck },
    { label: "Clients",          href: "/clients",                icon: UserCheck },
    { label: "Chantiers",        href: "/chantiers",              icon: HardHat },
    { label: "Consultations",    href: "/consultations",          icon: Mail },
    { label: "Logements",        href: "/logements",              icon: BedDouble },
    { label: "Bibliothèque",     href: "/articles",               icon: Library },
    { label: "Factures",         href: "/factures",               icon: FileText },
    { label: "Planning",         href: "/planning",               icon: Calendar },
    { label: "Gantt",            href: "/planning/gantt",         icon: GanttChart },
    { label: "Calendrier",       href: "/planning/calendrier",    icon: CalendarDays },
    { label: "Personnel",        href: "/planning/personnel",     icon: Users },
    { label: "Absences",         href: "/absences",               icon: CalendarOff },
    { label: "Notes de frais",   href: "/notes-de-frais",         icon: Receipt },
    { label: "Pointages",        href: "/pointages",              icon: MapPin },
    { label: "Rapports",         href: "/rapports",               icon: ClipboardList },
    { label: "Mon profil",       href: "/profil",                 icon: User },
    { label: "Paramètres",       href: "/parametres",             icon: Settings },
  ],

  TEAM_LEADER: [
    { label: "Dashboard",        href: "/dashboard",              icon: LayoutDashboard },
    { label: "Mon équipe",       href: "/planning/equipe",        icon: ClipboardList },
    { label: "Mes chantiers",    href: "/chantiers",              icon: HardHat },
    { label: "Mon planning",     href: "/planning/moi",           icon: Calendar },
    { label: "Calendrier",       href: "/planning/calendrier",    icon: CalendarDays },
    { label: "Personnel",        href: "/planning/personnel",     icon: Users },
    { label: "Gantt",            href: "/planning/gantt",         icon: GanttChart },
    { label: "Absences équipe",  href: "/absences",               icon: CalendarOff },
    { label: "Pointages équipe", href: "/pointages",              icon: MapPin },
    { label: "Mes absences",     href: "/mes-absences",           icon: CalendarOff },
    { label: "Notes de frais",   href: "/mes-notes-de-frais",     icon: Receipt },
    { label: "Mon pointage",     href: "/pointage",               icon: MapPin },
    { label: "Mon profil",       href: "/profil",                 icon: User },
  ],

  EMPLOYEE: [
    { label: "Dashboard",        href: "/dashboard",              icon: LayoutDashboard },
    { label: "Mon planning",     href: "/planning/moi",           icon: Calendar },
    { label: "Mes chantiers",    href: "/chantiers",              icon: HardHat },
    { label: "Mes absences",     href: "/mes-absences",           icon: CalendarOff },
    { label: "Notes de frais",   href: "/mes-notes-de-frais",     icon: Receipt },
    { label: "Pointage",         href: "/pointage",               icon: MapPin },
    { label: "Mon profil",       href: "/profil",                 icon: User },
  ],
}

/**
 * Lot 0 Comptabilité — entrée unique, ajoutée seulement si `visible` (flag serveur + rôle ADMIN + société,
 * calculé côté serveur : voir `isAccountingNavVisible` ; jamais pour SUPER_ADMIN dans le Lot 0). Insérée juste
 * après « Factures » ; si le menu n'a pas « Factures » ou contient déjà l'entrée, la liste est inchangée.
 * Affichage uniquement : la page `/comptabilite` applique sa propre garde serveur.
 */
export const ACCOUNTING_NAV_ITEM: NavItem = {
  label: "Comptabilité",
  href: "/comptabilite",
  icon: Calculator,
}

export function withAccountingNavItem(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true) return result
  if (result.some((item) => item.href === ACCOUNTING_NAV_ITEM.href)) return result
  const anchor = result.findIndex((item) => item.href === "/factures")
  if (anchor === -1) return result
  result.splice(anchor + 1, 0, ACCOUNTING_NAV_ITEM)
  return result
}

/** Raccourcis de la facturation complète, soumis à la visibilité calculée côté serveur. */
export const QUOTES_NAV_ITEM: NavItem = {
  label: "Devis",
  href: "/devis",
  icon: FileText,
}

const CREDIT_NOTES_NAV_ITEM: NavItem = {
  label: "Avoir",
  href: "/factures/avoirs",
  icon: Receipt,
}

export function withBillingNavItems(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true) return result
  const anchor = result.findIndex((item) => item.href === "/factures")
  if (anchor === -1) return result
  if (!result.some((item) => item.href === CREDIT_NOTES_NAV_ITEM.href)) {
    result.splice(anchor + 1, 0, CREDIT_NOTES_NAV_ITEM)
  }
  if (!result.some((item) => item.href === QUOTES_NAV_ITEM.href)) {
    result.splice(anchor, 0, QUOTES_NAV_ITEM)
  }
  return result
}

/** Entrées de menu d'un rôle (CLIENT et rôle inconnu → aucune entrée). */
export function getNavItems(role: Role): NavItem[] {
  return [...(NAV_ITEMS_BY_ROLE[role] ?? [])]
}

/**
 * Un href correspond au pathname : exactement, ou en parent sur une frontière de segment.
 * Dashboard : correspondance exacte uniquement. « /pointage » ne correspond jamais à « /pointages ».
 */
function matchesNavHref(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard"
  return pathname === href || pathname.startsWith(href + "/")
}

/**
 * Href de l'unique élément actif : parmi les correspondances valides, la plus spécifique (la plus longue).
 * Au plus un élément actif ; null si aucune entrée ne correspond.
 */
export function getActiveNavHref(items: readonly NavItem[], pathname: string): string | null {
  let active: string | null = null
  for (const item of items) {
    if (matchesNavHref(item.href, pathname) && (active === null || item.href.length > active.length)) {
      active = item.href
    }
  }
  return active
}

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Administrateur",
  TEAM_LEADER: "Chef d'équipe",
  EMPLOYEE: "Employé",
  CLIENT: "Client",
}

/**
 * SPEC-WORKSITE-PHOTOS-001 — entrée « Photos engins » (drapeau serveur PLANIFICATOR_WORKSITE_PHOTOS_ENABLED, rôles internes).
 * Affichage seulement : chaque route du module refuse côté serveur.
 */
export function withWorksitePhotosNavItem(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true || result.some(i => i.href === "/photos-engins")) return result
  const chantiers = result.findIndex(i => i.href === "/chantiers")
  result.splice(chantiers < 0 ? result.length : chantiers + 1, 0, { label: "Photos engins", href: "/photos-engins", icon: Camera })
  return result
}

/** Supplemental, server-resolved intake capability. Visibility never authorizes an action. */
export function withSupplierIntakeNavItem(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true || result.some(i => i.href === "/factures-fournisseurs")) return result
  const profile = result.findIndex(i => i.href === "/profil")
  result.splice(profile < 0 ? result.length : profile, 0, {
    label: "Factures fournisseurs & OCR", href: "/factures-fournisseurs", icon: Receipt,
  })
  return result
}

/** RH documents: supplemental server-resolved capabilities, never authority by menu visibility. */
export function withHrDocumentNavItems(items: readonly NavItem[], own: boolean, manage: boolean): NavItem[] {
  const result = [...items]
  if (own === true && !result.some(i => i.href === "/mes-documents")) result.push({label:"Mes documents",href:"/mes-documents",icon:FileText})
  if (manage === true && !result.some(i => i.href === "/rh/documents")) result.push({label:"Documents RH",href:"/rh/documents",icon:FileText})
  return result
}

/**
 * Veille prospection (V1) — entrée « Opportunités » (drapeau serveur PROSPECTION_WATCH_ENABLED + SUPER_ADMIN + société,
 * calculé côté serveur : voir `isProspectionNavVisible`). Insérée juste après « Consultations », sinon en fin de liste.
 * Affichage seulement : la page `/opportunites` applique sa propre garde serveur.
 */
export const PROSPECTION_NAV_ITEM: NavItem = { label: "Opportunités", href: "/opportunites", icon: Radar }

export function withProspectionNavItem(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true || result.some((item) => item.href === PROSPECTION_NAV_ITEM.href)) return result
  const anchor = result.findIndex((item) => item.href === "/consultations")
  result.splice(anchor < 0 ? result.length : anchor + 1, 0, PROSPECTION_NAV_ITEM)
  return result
}

/**
 * Lot A Planificator V2 : entrées « Stock » et « Achats » (drapeau serveur STOCK_PURCHASING_ENABLED, ADMIN et
 * SUPER_ADMIN avec société). Affichage seulement : chaque page et action du module refuse côté serveur.
 */
export function withStockPurchasingNavItems(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true) return result
  const profile = result.findIndex(i => i.href === "/profil")
  const add = [
    { label: "Stock", href: "/stock", icon: Boxes },
    { label: "Achats", href: "/achats", icon: ShoppingCart },
  ].filter(entry => !result.some(i => i.href === entry.href))
  result.splice(profile < 0 ? result.length : profile, 0, ...add)
  return result
}

/**
 * Lot B Planificator V2 : entrée « Matériel » (drapeau serveur EQUIPMENT_RENTAL_ENABLED, ADMIN et SUPER_ADMIN avec
 * société), placée après « Achats » si présent, sinon avant « Profil ». Affichage seulement : chaque page et action
 * du module refuse côté serveur.
 */
export function withEquipmentNavItem(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true || result.some(i => i.href === "/materiel")) return result
  const achats = result.findIndex(i => i.href === "/achats")
  const profile = result.findIndex(i => i.href === "/profil")
  const at = achats >= 0 ? achats + 1 : profile < 0 ? result.length : profile
  result.splice(at, 0, { label: "Matériel", href: "/materiel", icon: Wrench })
  return result
}
