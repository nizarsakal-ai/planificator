"use client"

import { useEffect, useId, useReducer } from "react"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { NavItem } from "@/lib/navigation/nav-config"
import type { NavCategory, NavCategoryId } from "@/lib/navigation/nav-categories"

/**
 * Catégories repliables partagées par la Sidebar et le MobileNav (rendu seulement : les entrées viennent de la
 * composition existante, regroupée par `groupNavItems`). Accessibilité : en-têtes `<button>` natifs (Entrée / Espace),
 * `aria-expanded` + `aria-controls` vers la liste (identifiants uniques par instance), lien actif `aria-current="page"`.
 * La catégorie active est ouverte dès le rendu et rouverte à CHAQUE navigation (clé = pathname, pas seulement l'entrée
 * active : passer de /chantiers/a à /chantiers/b rouvre « Chantiers & terrain » même si l'utilisateur l'avait repliée) ;
 * l'utilisateur peut replier / rouvrir librement. État local uniquement (aucune persistance, rien en stockage navigateur).
 */
export function NavItemLink({ item, active, onNavigate, nested = false }: { item: NavItem; active: boolean; onNavigate?: () => void; nested?: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg text-sm transition-colors group",
        nested ? "px-3 py-2" : "px-3 py-2.5 font-medium",
        active ? "bg-white/15 text-white font-semibold" : "text-slate-300 hover:bg-white/10 hover:text-white",
      )}
    >
      <item.icon className={cn("h-4 w-4 shrink-0 transition-colors", active ? "text-white" : "text-slate-400 group-hover:text-white")} aria-hidden="true" />
      <span className="flex-1">{item.label}</span>
      {item.badge && <span className="text-[10px] bg-white/10 text-slate-300 px-1.5 py-0.5 rounded">{item.badge}</span>}
    </Link>
  )
}

/** État d'ouverture : catégories ouvertes + dernière clé de navigation et dernière catégorie active vues. */
export interface NavOpenState { open: ReadonlySet<NavCategoryId>; navigationKey: string; activeCategoryId: NavCategoryId | null }
export type NavOpenEvent =
  | { type: "navigate"; navigationKey: string; activeCategoryId: NavCategoryId | null }
  | { type: "toggle"; id: NavCategoryId }

export function initialNavOpenState(navigationKey: string, activeCategoryId: NavCategoryId | null): NavOpenState {
  return { open: new Set(activeCategoryId ? [activeCategoryId] : []), navigationKey, activeCategoryId }
}

/**
 * Réducteur pur : une NOUVELLE clé de navigation, OU une nouvelle catégorie active sur la même route (props / drapeaux
 * actualisés), rouvre la catégorie active ; tant que ni l'une ni l'autre ne change, un repli manuel est respecté.
 */
export function reduceNavOpenState(state: NavOpenState, event: NavOpenEvent): NavOpenState {
  if (event.type === "toggle") {
    const open = new Set(state.open)
    if (open.has(event.id)) open.delete(event.id)
    else open.add(event.id)
    return { ...state, open }
  }
  if (event.navigationKey === state.navigationKey && event.activeCategoryId === state.activeCategoryId) return state
  const open = new Set(state.open)
  if (event.activeCategoryId) open.add(event.activeCategoryId)
  return { open, navigationKey: event.navigationKey, activeCategoryId: event.activeCategoryId }
}

export function NavCategories({
  categories, activeHref, activeCategoryId, navigationKey, onNavigate,
}: {
  categories: readonly NavCategory[]
  activeHref: string | null
  activeCategoryId: NavCategoryId | null
  /** Clé de navigation (pathname) fournie par le shell : chaque changement rouvre la catégorie active. */
  navigationKey: string
  onNavigate?: () => void
}) {
  const baseId = useId()
  const [state, dispatch] = useReducer(reduceNavOpenState, undefined, () => initialNavOpenState(navigationKey, activeCategoryId))
  // Après CHAQUE navigation (pathname), la catégorie active est rouverte ; les autres gardent leur état.
  useEffect(() => { dispatch({ type: "navigate", navigationKey, activeCategoryId }) }, [navigationKey, activeCategoryId])
  const open = state.open
  const toggle = (id: NavCategoryId) => dispatch({ type: "toggle", id })

  return (
    <div className="space-y-1">
      {categories.map((category) => {
        const expanded = open.has(category.id)
        const regionId = `${baseId}-nav-${category.id}`
        const containsActive = category.id === activeCategoryId
        return (
          <div key={category.id}>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={regionId}
              onClick={() => toggle(category.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                expanded || containsActive ? "text-white" : "text-slate-300",
              )}
            >
              <category.icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <span className="flex-1 text-left">{category.label}</span>
              <ChevronRight className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
            </button>
            <ul id={regionId} hidden={!expanded} className="ml-[19px] mt-0.5 mb-1.5 space-y-0.5 border-l border-white/15 pl-3">
              {category.items.map((item) => (
                <li key={item.href}>
                  <NavItemLink item={item} active={item.href === activeHref} onNavigate={onNavigate} nested />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
