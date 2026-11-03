"use client"

import { usePathname } from "next/navigation"
import { PlanificatorLogo } from "@/components/brand/PlanificatorLogo"
import {
  getNavItems,
  getActiveNavHref,
  withHrDocumentNavItems, withAccountingNavItem,
  withBillingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem,
} from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"
import { NavCategories } from "@/components/layout/NavCategories"
import { NavFooter } from "@/components/layout/NavFooter"
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
  hrDocumentsNavVisible?: boolean
  hrDocumentsManageNavVisible?: boolean
  supplierIntakeNavVisible?: boolean
  /** Photos d'engins (SPEC-WORKSITE-PHOTOS-001) : drapeau serveur + rôle interne ; affichage seulement. */
  worksitePhotosNavVisible?: boolean
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

/** Barre latérale « verre givré » : carte flottante translucide (thème clair ou sombre selon Apparence), catégories, pied commun. */
export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname()
  const navItems = withHrDocumentNavItems(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(user.role), user.accountingNavVisible === true), user.billingNavVisible === true), user.supplierIntakeNavVisible === true), user.worksitePhotosNavVisible === true), user.hrDocumentsNavVisible === true, user.hrDocumentsManageNavVisible === true)
  const activeHref = getActiveNavHref(navItems, pathname)
  // Regroupement par catégories APRÈS la composition des drapeaux : aucune entrée ajoutée, perdue ou dupliquée.
  const grouped = groupNavItems(navItems)
  const activeCategoryId = getActiveNavCategoryId(grouped, activeHref)

  return (
    // data-appearance-scope : surface qualifiée pour le thème sombre (Apparence).
    <aside data-appearance-scope="" className="hidden md:flex w-[17.5rem] shrink-0 h-screen py-3.5 pl-3.5">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-white/90 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_24px_60px_-30px_rgba(30,64,175,0.35)] backdrop-blur-xl dark:border-white/10 dark:bg-slate-50/80 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_24px_60px_-30px_rgba(0,0,0,0.7)]">
        <div className="flex h-[72px] shrink-0 items-center px-5">
          <PlanificatorLogo subtitle="Planning d'équipes" />
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="Menu principal">
          <NavCategories categories={grouped.categories} activeHref={activeHref} activeCategoryId={activeCategoryId} navigationKey={pathname} />
        </nav>

        {/* Pied : « Mon profil » (même lien, même libellé), identité + Déconnexion, Apparence. */}
        <NavFooter user={user} items={grouped.footer} activeHref={activeHref} />
      </div>
    </aside>
  )
}
