"use client"

import { signOut } from "next-auth/react"
import { LogOut } from "lucide-react"
import { cn, getInitials } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { AppearanceSwitcher } from "@/components/appearance/AppearanceSwitcher"
import { NavItemLink } from "@/components/layout/NavCategories"
import { ROLE_LABELS, type NavItem } from "@/lib/navigation/nav-config"
import type { Role } from "@prisma/client"

/**
 * Pied commun Sidebar / MobileNav : entrées du pied (« Mon profil », même lien et même libellé), carte d'identité avec
 * Déconnexion, puis le sélecteur Apparence. Affichage seulement.
 */
export function NavFooter({
  user, items, activeHref, onNavigate, touch = false,
}: {
  user: { id: string; name?: string | null; email?: string | null; image?: string | null; role: Role }
  items: readonly NavItem[]
  activeHref: string | null
  onNavigate?: () => void
  touch?: boolean
}) {
  return (
    <div className="shrink-0 space-y-2 border-t border-slate-200/80 p-2.5">
      {items.map((item) => (
        <NavItemLink key={item.href} item={item} active={item.href === activeHref} onNavigate={onNavigate} touch={touch} />
      ))}
      <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 p-2">
        <Avatar className="h-[34px] w-[34px] shrink-0">
          <AvatarImage src={user.image ?? undefined} />
          <AvatarFallback className="bg-gradient-to-br from-[#2f62f0] to-[#1d4ed8] text-xs font-semibold text-white">
            {getInitials(user.name ?? user.email ?? "?")}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-slate-900">{user.name ?? user.email}</p>
          <p className="truncate text-[11.5px] text-slate-500">{ROLE_LABELS[user.role]}</p>
        </div>
        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          aria-label="Déconnexion"
          title="Déconnexion"
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 outline-none transition-colors",
            "hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-blue-500/60 motion-reduce:transition-none",
            touch ? "h-11 w-11" : "h-8 w-8",
          )}
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <AppearanceSwitcher userId={user.id} touch={touch} />
    </div>
  )
}
