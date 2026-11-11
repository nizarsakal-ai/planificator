"use client"

import { usePathname } from "next/navigation"
import { PlanificatorLogo } from "@/components/brand/PlanificatorLogo"
import {
  getNavItems,
  getActiveNavHref,
  withHrDocumentNavItems, withAccountingNavItem,
  withBillingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem, withProspectionNavItem, withStockPurchasingNavItems, withEquipmentNavItem,
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
  prospectionNavVisible?: boolean
  /** Lot A V2 : « Stock » et « Achats » (drapeau STOCK_PURCHASING_ENABLED + ADMIN/SUPER_ADMIN + société) ; affichage seulement. */
  stockPurchasingNavVisible?: boolean
  /** Lot B V2 : « Matériel » (drapeau EQUIPMENT_RENTAL_ENABLED + ADMIN/SUPER_ADMIN + société) ; affichage seulement. */
  equipmentNavVisible?: boolean
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

/** Barre latérale « verre givré » : carte flottante translucide (thème clair ou sombre selon Apparence), catégories, pied commun. */
export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname()
  const navItems = withStockPurchasingNavItems(withProspectionNavItem(withHrDocumentNavItems(withEquipmentNavItem(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(user.role), user.accountingNavVisible === true), user.billingNavVisible === true), user.supplierIntakeNavVisible === true), user.worksitePhotosNavVisible === true), user.equipmentNavVisible === true), user.hrDocumentsNavVisible === true, user.hrDocumentsManageNavVisible === true), user.prospectionNavVisible === true), user.stockPurchasingNavVisible === true)
  const activeHref = getActiveNavHref(navItems, pathname)
  // Regroupement par catégories APRÈS la composition des drapeaux : aucune entrée ajoutée, perdue ou dupliquée.
  const grouped = groupNavItems(navItems)
  const activeCategoryId = getActiveNavCategoryId(grouped, activeHref)

  return (
    // data-appearance-scope : surface qualifiée pour le thème sombre (Apparence).
    <aside data-appearance-scope="" className="hidden md:flex w-[17.5rem] shrink-0 h-screen py-3.5 pl-3.5">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-[#0f3460]/10 bg-[#fffaf0]/75 shadow-[0_8px_18px_-8px_rgba(15,52,96,0.3),0_40px_80px_-28px_rgba(15,52,96,0.65)] backdrop-blur-xl dark:border-white/10 dark:bg-slate-50/80 dark:shadow-[0_24px_60px_-30px_rgba(0,0,0,0.7)]">
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
