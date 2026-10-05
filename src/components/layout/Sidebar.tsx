"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { LogOut, ChevronRight } from "lucide-react"
import { cn, getInitials } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { PlanificatorLogo } from "@/components/brand/PlanificatorLogo"
import {
  getNavItems,
  isNavItemActive,
  ROLE_LABELS,
  type NavItem,
} from "@/lib/navigation/nav-config"
import type { Role } from "@prisma/client"

// ─── Types ───────────────────────────────────────────────────────────────────

interface SidebarUser {
  id: string
  name?: string | null
  email?: string | null
  image?: string | null
  role: Role
  companyId: string | null
}

// ─── Composant NavItem ────────────────────────────────────────────────────────

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors group",
        active
          ? "bg-white/15 text-white"
          : "text-slate-300 hover:bg-white/10 hover:text-white"
      )}
    >
      <item.icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active ? "text-white" : "text-slate-400 group-hover:text-white"
        )}
      />
      <span className="flex-1">{item.label}</span>
      {item.badge && (
        <span className="text-[10px] bg-white/10 text-slate-300 px-1.5 py-0.5 rounded">
          {item.badge}
        </span>
      )}
      {active && <ChevronRight className="h-3 w-3 text-white/50" />}
    </Link>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname()
  const navItems = getNavItems(user.role)

  return (
    <aside className="hidden md:flex w-64 shrink-0 bg-[#0f3460] flex-col h-screen">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-white/10">
        <PlanificatorLogo subtitle="Planning d'équipes" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isNavItemActive(item.href, pathname)}
          />
        ))}
      </nav>

      {/* Footer utilisateur */}
      <div className="border-t border-white/10 p-4">
        <div className="flex items-center gap-3 mb-3">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarImage src={user.image ?? undefined} />
            <AvatarFallback className="bg-white/20 text-white text-xs font-medium">
              {getInitials(user.name ?? user.email ?? "?")}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-white text-xs font-medium truncate">
              {user.name ?? user.email}
            </p>
            <p className="text-slate-400 text-[11px] truncate">
              {ROLE_LABELS[user.role]}
            </p>
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
    </aside>
  )
}
