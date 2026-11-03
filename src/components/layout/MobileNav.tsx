"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { Menu, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { PlanificatorLogo } from "@/components/brand/PlanificatorLogo"
import { getActiveNavHref, getNavItems, withHrDocumentNavItems, withAccountingNavItem, withBillingNavItems, withSupplierIntakeNavItem, withWorksitePhotosNavItem } from "@/lib/navigation/nav-config"
import { getActiveNavCategoryId, groupNavItems } from "@/lib/navigation/nav-categories"
import { NavCategories } from "@/components/layout/NavCategories"
import { NavFooter } from "@/components/layout/NavFooter"
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
  hrDocumentsNavVisible?: boolean
  hrDocumentsManageNavVisible?: boolean
  supplierIntakeNavVisible?: boolean
  worksitePhotosNavVisible?: boolean
}

/**
 * Éléments focalisables RÉELLEMENT rendus du tiroir : exclus sous un ancêtre `[hidden]` (catégorie repliée) ou `[inert]`,
 * et sans rectangle rendu. Tiroir masqué par le CSS (passage en ≥ md pendant qu'il est ouvert) ⇒ [] : le piège ne bloque
 * alors jamais Tab. Un groupe de boutons radio (Apparence) n'offre qu'un arrêt de tabulation : le bouton coché, sinon
 * le premier du groupe, comme le navigateur.
 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  if (root.getClientRects().length === 0 || root.closest("[inert]")) return []
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  const visible = Array.from(root.querySelectorAll<HTMLElement>(selector))
    .filter((el) => !el.closest("[hidden], [inert]") && el.getClientRects().length > 0)
  const radioStop = new Map<string, HTMLInputElement>()
  for (const el of visible) {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) continue
    const current = radioStop.get(el.name)
    if (!current || (el.checked && !current.checked)) radioStop.set(el.name, el)
  }
  return visible.filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && el.name) || radioStop.get(el.name) === el)
}

export function MobileNav({ user }: { user: MobileNavUser }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const navItems = withHrDocumentNavItems(withWorksitePhotosNavItem(withSupplierIntakeNavItem(withBillingNavItems(withAccountingNavItem(getNavItems(user.role), user.accountingNavVisible === true), user.billingNavVisible === true), user.supplierIntakeNavVisible === true), user.worksitePhotosNavVisible === true), user.hrDocumentsNavVisible === true, user.hrDocumentsManageNavVisible === true)
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
        className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500/60 transition-colors motion-reduce:transition-none"
        aria-label="Ouvrir le menu"
        aria-expanded={open}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/45 backdrop-blur-[2px] md:hidden dark:bg-black/60"
          onClick={closeAndRestoreFocus}
        />
      )}

      {/* Drawer : carte flottante, mêmes catégories et même pied que la Sidebar ; cibles tactiles de 44 px. */}
      {/* Fermé : hors de l'ordre de tabulation et des technologies d'assistance (inert + aria-hidden). */}
      <div
        className={cn(
          "fixed bottom-2 left-2 top-2 z-50 flex w-[19rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-[28px] border border-white/90 bg-white/[0.94] shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_24px_60px_-20px_rgba(15,23,42,0.45)] backdrop-blur-2xl dark:border-white/10 dark:bg-slate-50/90 transition-transform duration-300 ease-out motion-reduce:transition-none md:hidden",
          open ? "translate-x-0" : "-translate-x-[calc(100%+1rem)]"
        )}
        data-appearance-scope=""
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-label="Menu de navigation"
        aria-hidden={open ? undefined : true}
        inert={!open}
        ref={drawerRef}
      >
        {/* Header */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 pl-4 pr-2">
          <PlanificatorLogo subtitle="Planning d'équipes" />
          <button
            ref={closeButtonRef}
            onClick={closeAndRestoreFocus}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-blue-500/60 motion-reduce:transition-none"
            aria-label="Fermer le menu"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="Menu principal">
          {/* Un clic sur un lien ferme le menu (comportement existant conservé) ; replier une catégorie ne le ferme pas. */}
          <NavCategories categories={grouped.categories} activeHref={activeHref} activeCategoryId={activeCategoryId} navigationKey={pathname} onNavigate={close} touch />
        </nav>

        {/* Pied : « Mon profil » (même lien), identité + Déconnexion, Apparence. */}
        <NavFooter user={user} items={grouped.footer} activeHref={activeHref} onNavigate={close} touch />
      </div>
    </>
  )
}
