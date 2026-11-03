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
 * Pied commun Sidebar / MobileNav : entrées du pied (« Mon profil », même lien et même libellé), sélecteur Apparence,
 * puis carte d'identité avec Déconnexion. Affichage seulement.
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
    <div className="shrink-0 space-y-2 px-3 pb-3 pt-1">
      {items.map((item) => (
        <NavItemLink key={item.href} item={item} active={item.href === activeHref} onNavigate={onNavigate} touch={touch} />
      ))}
      <AppearanceSwitcher userId={user.id} touch={touch} />
      <div className="flex items-center gap-2.5 rounded-[18px] border border-[#0f3460]/10 bg-white/80 p-2.5 shadow-[0_2px_4px_rgba(15,52,96,0.1),0_12px_26px_-12px_rgba(15,52,96,0.5)] dark:border-white/10 dark:bg-white/5 dark:shadow-none">
        <Avatar className="h-[34px] w-[34px] shrink-0">
          <AvatarImage src={user.image ?? undefined} />
          <AvatarFallback className="bg-gradient-to-br from-[#1b4a85] to-[#0f3460] text-xs font-semibold text-white">
            {getInitials(user.name ?? user.email ?? "?")}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-slate-900">{user.name ?? user.email}</p>
          <p className="truncate text-[11.5px] text-slate-600">{ROLE_LABELS[user.role]}</p>
        </div>
        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          aria-label="Déconnexion"
          title="Déconnexion"
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-[10px] text-slate-500 outline-none transition-colors",
            "hover:bg-[#efe7d8] hover:text-slate-900 dark:hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-blue-500/60 motion-reduce:transition-none",
            touch ? "h-11 w-11" : "h-8 w-8",
          )}
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
