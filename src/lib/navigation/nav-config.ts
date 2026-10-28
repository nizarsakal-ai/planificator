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

/**
 * Lot C (facturation complète) — entrée « Devis », ajoutée seulement si `visible` (drapeau serveur
 * BILLING_COMPLETE_ENABLED + rôle ADMIN/SUPER_ADMIN + société, calculé côté serveur). Insérée juste avant
 * « Factures » ; sans « Factures » ou déjà présente, la liste est inchangée. Affichage uniquement.
 */
export const QUOTES_NAV_ITEM: NavItem = {
  label: "Devis",
  href: "/devis",
  icon: FileText,
}

export function withBillingNavItems(items: readonly NavItem[], visible: boolean): NavItem[] {
  const result = [...items]
  if (visible !== true) return result
  if (result.some((item) => item.href === QUOTES_NAV_ITEM.href)) return result
  const anchor = result.findIndex((item) => item.href === "/factures")
  if (anchor === -1) return result
  result.splice(anchor, 0, QUOTES_NAV_ITEM)
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
