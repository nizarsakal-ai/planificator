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

/** Barre latérale « premium » : carte flottante (thème clair ou sombre selon Apparence), catégories, pied commun. */
export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname()
  const navItems = withHrDocumentNavItems(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(user.role), user.accountingNavVisible === true), user.billingNavVisible === true), user.supplierIntakeNavVisible === true), user.worksitePhotosNavVisible === true), user.hrDocumentsNavVisible === true, user.hrDocumentsManageNavVisible === true)
  const activeHref = getActiveNavHref(navItems, pathname)
  // Regroupement par catégories APRÈS la composition des drapeaux : aucune entrée ajoutée, perdue ou dupliquée.
  const grouped = groupNavItems(navItems)
  const activeCategoryId = getActiveNavCategoryId(grouped, activeHref)

  return (
    // data-appearance-scope : surface qualifiée pour le thème sombre (Apparence).
    <aside data-appearance-scope="" className="hidden md:flex w-[17.25rem] shrink-0 h-screen py-3 pl-3">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_32px_-12px_rgba(16,24,40,0.14)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_16px_40px_-16px_rgba(0,0,0,0.6)]">
        <div className="flex h-16 shrink-0 items-center px-4">
          <PlanificatorLogo subtitle="Planning d'équipes" />
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 pb-3 pt-1" aria-label="Menu principal">
          <NavCategories categories={grouped.categories} activeHref={activeHref} activeCategoryId={activeCategoryId} navigationKey={pathname} />
        </nav>

        {/* Pied : « Mon profil » (même lien, même libellé), identité + Déconnexion, Apparence. */}
        <NavFooter user={user} items={grouped.footer} activeHref={activeHref} />
      </div>
    </aside>
  )
}
