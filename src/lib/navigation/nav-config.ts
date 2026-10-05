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

/** Entrées de menu d'un rôle (CLIENT et rôle inconnu → aucune entrée). */
export function getNavItems(role: Role): NavItem[] {
  return [...(NAV_ITEMS_BY_ROLE[role] ?? [])]
}

/**
 * Règle de lien actif — reprise à l'identique (PR1).
 * Collisions connues conservées volontairement (/planning/*, /pointages) : corrigées en PR2.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href)
}

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Administrateur",
  TEAM_LEADER: "Chef d'équipe",
  EMPLOYEE: "Employé",
  CLIENT: "Client",
}
