"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { Menu, X, LogOut } from "lucide-react"
import { cn, getInitials } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PlanificatorLogo } from "@/components/brand/PlanificatorLogo"
import { getActiveNavHref, getNavItems, withAccountingNavItem, withBillingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem, ROLE_LABELS } from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"
import { NavCategories, NavItemLink } from "@/components/layout/NavCategories"
import type { Role } from "@prisma/client"

interface MobileNavUser {
  id: string
  name?: string | null
  email?: string | null
  image?: string | null
  role: Role
  /** Calculé côté serveur (flag + rôle + société) ; affichage seulement, pas une autorisation. */
  accountingNavVisible?: boolean
  /** Lot C : lien « Devis » (drapeau BILLING_COMPLETE_ENABLED) ; affichage seulement. */
  billingNavVisible?: boolean
  supplierIntakeNavVisible?: boolean
  worksitePhotosNavVisible?: boolean
}

/**
 * Éléments focalisables RÉELLEMENT rendus du tiroir : exclus sous un ancêtre `[hidden]` (catégorie repliée) ou `[inert]`,
 * et sans rectangle rendu. Tiroir masqué par le CSS (passage en ≥ md pendant qu'il est ouvert) ⇒ [] : le piège ne bloque
 * alors jamais Tab.
 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  if (root.getClientRects().length === 0 || root.closest("[inert]")) return []
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
    .filter((el) => !el.closest("[hidden], [inert]") && el.getClientRects().length > 0)
}

export function MobileNav({ user }: { user: MobileNavUser }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const navItems = withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(user.role), user.accountingNavVisible === true), user.billingNavVisible === true), user.supplierIntakeNavVisible === true), user.worksitePhotosNavVisible === true)
  const activeHref = getActiveNavHref(navItems, pathname)
  // Mêmes catégories que la Sidebar, regroupées APRÈS la composition des drapeaux.
  const grouped = groupNavItems(navItems)
  const activeCategoryId = getActiveNavCategoryId(grouped, activeHref)
  const close = () => setOpen(false)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  /** Fermeture explicite (Échap, bouton Fermer, voile) : le focus revient au bouton d'ouverture. */
  const closeAndRestoreFocus = () => { setOpen(false); openButtonRef.current?.focus() }

  // Tiroir ouvert (modal) : focus sur « Fermer » ; Tab / Maj+Tab confinés au tiroir ; Échap referme et rend le focus
  // au bouton d'ouverture. Piège borné, sans dépendance : premier et dernier éléments focalisables visibles.
  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); openButtonRef.current?.focus(); return }
      if (event.key !== "Tab" || !drawerRef.current) return
      const focusables = focusableIn(drawerRef.current)
      if (focusables.length === 0) return
      const first = focusables[0], last = focusables[focusables.length - 1]
      const current = document.activeElement
      if (event.shiftKey && (current === first || !drawerRef.current.contains(current))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (current === last || !drawerRef.current.contains(current))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open])

  return (
    <>
      {/* Hamburger button — visible on mobile only */}
      <button
        ref={openButtonRef}
        onClick={() => setOpen(true)}
        className="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
        aria-label="Ouvrir le menu"
        aria-expanded={open}
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={closeAndRestoreFocus}
        />
      )}

      {/* Drawer */}
      {/* Fermé : hors de l'ordre de tabulation et des technologies d'assistance (inert + aria-hidden). */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-72 bg-[#0f3460] flex flex-col transition-transform duration-300 md:hidden",
          open ? "translate-x-0" : "-translate-x-full"
        )}
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-label="Menu de navigation"
        aria-hidden={open ? undefined : true}
        inert={!open}
        ref={drawerRef}
      >
        {/* Header */}
        <div className="px-5 py-5 border-b border-white/10 flex items-center justify-between">
          <PlanificatorLogo />
          <button
            ref={closeButtonRef}
            onClick={closeAndRestoreFocus}
            className="text-slate-400 hover:text-white p-1 transition-colors"
            aria-label="Fermer le menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Menu principal">
          {/* Un clic sur un lien ferme le menu (comportement existant conservé) ; replier une catégorie ne le ferme pas. */}
          <NavCategories categories={grouped.categories} activeHref={activeHref} activeCategoryId={activeCategoryId} navigationKey={pathname} onNavigate={close} />
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
              <p className="text-slate-400 text-[11px]">{ROLE_LABELS[user.role]}</p>
            </div>
          </div>
          {grouped.footer.map((item) => (
            <NavItemLink key={item.href} item={item} active={item.href === activeHref} onNavigate={close} />
          ))}
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
