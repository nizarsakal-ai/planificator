"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import {
  Menu,
  X,
  LayoutDashboard,
  Building2,
  Users,
  Layers,
  UserCheck,
  HardHat,
  Calendar,
  CalendarOff,
  Settings,
  LogOut,
  ChevronRight,
  User,
  GanttChart,
  ClipboardList,
  Receipt,
  MapPin,
  CalendarDays,
} from "lucide-react"
import { cn, getInitials } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import type { Role } from "@prisma/client"

interface NavItem {
  label: string
  href: string
  icon: React.ElementType
}

interface MobileNavUser {
  id: string
  name?: string | null
  email?: string | null
  image?: string | null
  role: Role
}

function getNavItems(role: Role): NavItem[] {
  switch (role) {
    case "SUPER_ADMIN":
      return [
        { label: "Dashboard",    href: "/dashboard",              icon: LayoutDashboard },
        { label: "Entreprises",  href: "/super-admin/entreprises", icon: Building2 },
      ]
    case "ADMIN":
      return [
        { label: "Dashboard",      href: "/dashboard",       icon: LayoutDashboard },
        { label: "Employés",       href: "/employes",        icon: Users },
        { label: "Équipes",        href: "/equipes",         icon: Layers },
        { label: "Clients",        href: "/clients",         icon: UserCheck },
        { label: "Chantiers",      href: "/chantiers",       icon: HardHat },
        { label: "Planning",       href: "/planning",              icon: Calendar },
        { label: "Gantt",          href: "/planning/gantt",        icon: GanttChart },
        { label: "Calendrier",     href: "/planning/calendrier",   icon: CalendarDays },
        { label: "Personnel",      href: "/planning/personnel",    icon: Users },
        { label: "Absences",       href: "/absences",        icon: CalendarOff },
        { label: "Notes de frais", href: "/notes-de-frais",  icon: Receipt },
        { label: "Pointages",      href: "/pointages",       icon: MapPin },
        { label: "Rapports",       href: "/rapports",        icon: ClipboardList },
        { label: "Mon profil",     href: "/profil",          icon: User },
        { label: "Paramètres",     href: "/parametres",      icon: Settings },
      ]
    case "TEAM_LEADER":
      return [
        { label: "Dashboard",          href: "/dashboard",              icon: LayoutDashboard },
        { label: "Mon équipe",         href: "/planning/equipe",        icon: ClipboardList },
        { label: "Mes chantiers",      href: "/chantiers",              icon: HardHat },
        { label: "Mon planning",       href: "/planning/moi",           icon: Calendar },
        { label: "Calendrier",         href: "/planning/calendrier",    icon: CalendarDays },
        { label: "Personnel",          href: "/planning/personnel",     icon: Users },
        { label: "Gantt",              href: "/planning/gantt",         icon: GanttChart },
        { label: "Absences équipe",    href: "/absences",               icon: CalendarOff },
        { label: "Pointages équipe",   href: "/pointages",              icon: MapPin },
        { label: "Mes absences",       href: "/mes-absences",           icon: CalendarOff },
        { label: "Notes de frais",     href: "/mes-notes-de-frais",     icon: Receipt },
        { label: "Mon pointage",       href: "/pointage",               icon: MapPin },
        { label: "Mon profil",         href: "/profil",                 icon: User },
      ]
    case "EMPLOYEE":
      return [
        { label: "Dashboard",      href: "/dashboard",          icon: LayoutDashboard },
        { label: "Mon planning",   href: "/planning/moi",       icon: Calendar },
        { label: "Mes chantiers",  href: "/chantiers",          icon: HardHat },
        { label: "Mes absences",   href: "/mes-absences",       icon: CalendarOff },
        { label: "Notes de frais", href: "/mes-notes-de-frais", icon: Receipt },
        { label: "Pointage",       href: "/pointage",           icon: MapPin },
        { label: "Mon profil",     href: "/profil",             icon: User },
      ]
    default:
      return []
  }
}

const roleLabel: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Administrateur",
  TEAM_LEADER: "Chef d'équipe",
  EMPLOYEE: "Employé",
  CLIENT: "Client",
}

export function MobileNav({ user }: { user: MobileNavUser }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const navItems = getNavItems(user.role)

  return (
    <>
      {/* Hamburger button — visible on mobile only */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
        aria-label="Ouvrir le menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Drawer */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-72 bg-[#0f3460] flex flex-col transition-transform duration-300 md:hidden",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Header */}
        <div className="px-5 py-5 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white text-[#0f3460] flex items-center justify-center font-bold text-sm shrink-0">
              P
            </div>
            <p className="text-white font-bold text-sm">Planificator</p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="text-slate-400 hover:text-white p-1 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const active = item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  active
                    ? "bg-white/15 text-white"
                    : "text-slate-300 hover:bg-white/10 hover:text-white"
                )}
              >
                <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-slate-400")} />
                <span className="flex-1">{item.label}</span>
                {active && <ChevronRight className="h-3 w-3 text-white/50" />}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/10 p-4">
          <div className="flex items-center gap-3 mb-3">
            <Avatar className="h-8 w-8 shrink-0">
              <AvatarImage src={user.image ?? undefined} />
              <AvatarFallback className="bg-white/20 text-white text-xs font-medium">
                {getInitials(user.name ?? user.email ?? "?")}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-white text-xs font-medium truncate">{user.name ?? user.email}</p>
              <p className="text-slate-400 text-[11px]">{roleLabel[user.role]}</p>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white text-sm transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Déconnexion
          </button>
        </div>
      </div>
    </>
  )
}
