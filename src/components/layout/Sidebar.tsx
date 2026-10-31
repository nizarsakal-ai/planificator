"use client"

import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { LogOut } from "lucide-react"
import { getInitials } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { PlanificatorLogo } from "@/components/brand/PlanificatorLogo"
import {
  getNavItems,
  getActiveNavHref,
  withAccountingNavItem,
  withBillingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem,
  ROLE_LABELS,
} from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"
import { NavCategories, NavItemLink } from "@/components/layout/NavCategories"
import type { Role } from "@prisma/client"

// ─── Types ───────────────────────────────────────────────────────────────────

interface SidebarUser {
  id: string
  name?: string | null
  email?: string | null
  image?: string | null
  role: Role
  companyId: string | null
  /** Calculé côté serveur (flag + rôle + société) ; affichage seulement, pas une autorisation. */
  accountingNavVisible?: boolean
  /** Lot C : lien « Devis » (drapeau BILLING_COMPLETE_ENABLED) ; affichage seulement. */
  billingNavVisible?: boolean
  supplierIntakeNavVisible?: boolean
  /** Photos d'engins (SPEC-WORKSITE-PHOTOS-001) : drapeau serveur + rôle interne ; affichage seulement. */
  worksitePhotosNavVisible?: boolean
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname()
  const navItems = withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(user.role), user.accountingNavVisible === true), user.billingNavVisible === true), user.supplierIntakeNavVisible === true), user.worksitePhotosNavVisible === true)
  const activeHref = getActiveNavHref(navItems, pathname)
  // Regroupement par catégories APRÈS la composition des drapeaux : aucune entrée ajoutée, perdue ou dupliquée.
  const grouped = groupNavItems(navItems)
  const activeCategoryId = getActiveNavCategoryId(grouped, activeHref)

  return (
    <aside className="hidden md:flex w-64 shrink-0 bg-[#0f3460] flex-col h-screen">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-white/10">
        <PlanificatorLogo subtitle="Planning d'équipes" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Menu principal">
        <NavCategories categories={grouped.categories} activeHref={activeHref} activeCategoryId={activeCategoryId} navigationKey={pathname} />
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
        {/* « Mon profil » (pied) : même lien, même libellé qu'avant, hors catégories. */}
        {grouped.footer.map((item) => (
          <NavItemLink key={item.href} item={item} active={item.href === activeHref} />
        ))}
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
