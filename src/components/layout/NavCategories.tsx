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
 * Style « premium » : lien actif en pastille dégradée bleu Planificator ; transitions coupées si `prefers-reduced-motion`.
 * `touch` agrandit les cibles (menu mobile, 44 px).
 */
export function NavItemLink({ item, active, onNavigate, touch = false }: { item: NavItem; active: boolean; onNavigate?: () => void; touch?: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] tracking-[-0.005em] outline-none",
        "transition-[background-color,color,box-shadow] duration-200 motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-blue-500/60",
        touch ? "h-11" : "h-9",
        active
          ? "bg-gradient-to-br from-[#2f62f0] to-[#1d4ed8] font-semibold text-white shadow-[0_8px_18px_-8px_rgba(37,99,235,0.6)]"
          : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      )}
    >
      <item.icon className={cn("h-4 w-4 shrink-0 transition-colors motion-reduce:transition-none", active ? "text-white" : "text-slate-400 group-hover:text-slate-600")} aria-hidden="true" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && <span className={cn("rounded px-1.5 py-0.5 text-[10px]", active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500")}>{item.badge}</span>}
      {active && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden="true" />}
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
  categories, activeHref, activeCategoryId, navigationKey, onNavigate, touch = false,
}: {
  categories: readonly NavCategory[]
  activeHref: string | null
  activeCategoryId: NavCategoryId | null
  /** Clé de navigation (pathname) fournie par le shell : chaque changement rouvre la catégorie active. */
  navigationKey: string
  onNavigate?: () => void
  touch?: boolean
}) {
  const baseId = useId()
  const [state, dispatch] = useReducer(reduceNavOpenState, undefined, () => initialNavOpenState(navigationKey, activeCategoryId))
  // Après CHAQUE navigation (pathname), la catégorie active est rouverte ; les autres gardent leur état.
  useEffect(() => { dispatch({ type: "navigate", navigationKey, activeCategoryId }) }, [navigationKey, activeCategoryId])
  const open = state.open
  const toggle = (id: NavCategoryId) => dispatch({ type: "toggle", id })

  return (
    <div className="space-y-0.5">
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
                "flex w-full items-center gap-3 rounded-xl px-2.5 text-[13.5px] tracking-[-0.005em] outline-none",
                "transition-colors duration-200 motion-reduce:transition-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500/60",
                touch ? "h-11" : "h-10",
                containsActive ? "font-semibold text-slate-900" : "font-medium text-slate-600",
                containsActive && !expanded && "bg-blue-50 hover:bg-blue-100/70 dark:bg-blue-400/15 dark:hover:bg-blue-400/20",
              )}
            >
              <category.icon className={cn("h-[18px] w-[18px] shrink-0", containsActive ? "text-blue-600 dark:text-blue-300" : "text-slate-400")} aria-hidden="true" />
              <span className="flex-1 text-left">{category.label}</span>
              {!expanded && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-100 px-1.5 text-[11px] font-semibold text-slate-600" aria-hidden="true">
                  {category.items.length}
                </span>
              )}
              <ChevronRight className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-90")} aria-hidden="true" />
            </button>
            <ul id={regionId} hidden={!expanded} className="mb-1.5 ml-[19px] mt-0.5 space-y-0.5 border-l border-slate-200 pl-2.5">
              {category.items.map((item) => (
                <li key={item.href}>
                  <NavItemLink item={item} active={item.href === activeHref} onNavigate={onNavigate} touch={touch} />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
