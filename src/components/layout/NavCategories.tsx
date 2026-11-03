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
 * Style « verre givré » : catégorie ouverte en titre de section, lien actif en pastille blanche avec icône dans une
 * tuile bleu Planificator ; transitions coupées si `prefers-reduced-motion`. `touch` agrandit les cibles (mobile, 44 px).
 * `quietIcon` : l'icône d'un lien inactif est masquée (liens d'une catégorie, alignés sous le libellé actif).
 */
export function NavItemLink({ item, active, onNavigate, touch = false, quietIcon = false }: { item: NavItem; active: boolean; onNavigate?: () => void; touch?: boolean; quietIcon?: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-2.5 rounded-xl px-1.5 text-[13.5px] tracking-[-0.005em] outline-none",
        "transition-[background-color,color,box-shadow] duration-200 motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-blue-500/60",
        touch ? "h-11" : active ? "h-10" : "h-9",
        active
          ? "bg-white font-semibold text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_20px_-10px_rgba(37,99,235,0.35)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_10px_24px_-12px_rgba(0,0,0,0.6)]"
          : "font-medium text-slate-600 hover:bg-white/70 hover:text-slate-900 dark:hover:bg-white/5",
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]",
          active && "bg-gradient-to-br from-[#3b6cf6] to-[#1d4ed8] text-white shadow-[0_6px_14px_-6px_rgba(29,78,216,0.7)]",
        )}
        aria-hidden="true"
      >
        {(active || !quietIcon) && (
          <item.icon className={cn("h-4 w-4 transition-colors motion-reduce:transition-none", !active && "text-slate-400 group-hover:text-slate-600")} />
        )}
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && <span className={cn("rounded px-1.5 py-0.5 text-[10px]", active ? "bg-blue-50 text-blue-700 dark:bg-blue-400/15 dark:text-blue-200" : "bg-slate-100 text-slate-500")}>{item.badge}</span>}
      {active && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />}
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
                "group/cat flex w-full items-center gap-2.5 rounded-xl px-2.5 outline-none",
                "transition-colors duration-200 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-blue-500/60",
                // Ouverte : titre de section ; repliée : ligne avec icône et nombre de liens.
                expanded
                  ? cn("mt-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-600 hover:text-slate-900", touch ? "h-11" : "h-8")
                  : cn("text-[13.5px] tracking-[-0.005em] hover:bg-white/70 dark:hover:bg-white/5", touch ? "h-11" : "h-9",
                      containsActive ? "bg-blue-50 font-semibold text-slate-900 hover:bg-blue-100/70 dark:bg-blue-400/15 dark:hover:bg-blue-400/20" : "font-medium text-slate-600"),
              )}
            >
              {!expanded && (
                <category.icon className={cn("h-[18px] w-[18px] shrink-0", containsActive ? "text-blue-600 dark:text-blue-300" : "text-slate-400")} aria-hidden="true" />
              )}
              <span className="flex-1 text-left">{category.label}</span>
              {!expanded && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900/[0.05] px-2 text-[11px] font-semibold text-slate-600" aria-hidden="true">
                  {category.items.length}
                </span>
              )}
              {expanded && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 rotate-90 opacity-0 transition-opacity group-hover/cat:opacity-100 group-focus-visible/cat:opacity-100 motion-reduce:transition-none" aria-hidden="true" />
              )}
            </button>
            <ul id={regionId} hidden={!expanded} className="mb-1 space-y-0.5">
              {category.items.map((item) => (
                <li key={item.href}>
                  <NavItemLink item={item} active={item.href === activeHref} onNavigate={onNavigate} touch={touch} quietIcon />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
