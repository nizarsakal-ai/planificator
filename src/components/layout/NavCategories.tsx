"use client"

import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { SHADOW_RAISED, SHADOW_SLIDER } from "@/components/ui/shadows"
import type { NavItem } from "@/lib/navigation/nav-config"
import type { NavCategory, NavCategoryId } from "@/lib/navigation/nav-categories"

/**
 * Catégories repliables partagées par la Sidebar et le MobileNav (rendu seulement : les entrées viennent de la
 * composition existante, regroupée par `groupNavItems`). Accessibilité : en-têtes `<button>` natifs (Entrée / Espace),
 * `aria-expanded` + `aria-controls` vers la liste (identifiants uniques par instance), lien actif `aria-current="page"`.
 * La catégorie active est ouverte dès le rendu et rouverte à CHAQUE navigation (clé = pathname, pas seulement l'entrée
 * active : passer de /chantiers/a à /chantiers/b rouvre « Chantiers & terrain » même si l'utilisateur l'avait repliée) ;
 * l'utilisateur peut replier / rouvrir librement. État local uniquement (aucune persistance, rien en stockage navigateur).
 * Style « verre givré » : catégorie ouverte en titre de section ; dans les catégories, un curseur bleu en relief glisse
 * d'un lien à l'autre (voir `SliderNavLink`) ; `NavItemLink` (pied) garde la pastille blanche. Transitions coupées si
 * `prefers-reduced-motion`. `touch` agrandit les cibles (mobile, 44 px).
 */
export function NavItemLink({ item, active, onNavigate, touch = false }: { item: NavItem; active: boolean; onNavigate?: () => void; touch?: boolean }) {
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
          ? cn("bg-white font-semibold text-slate-900", SHADOW_RAISED, "dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_10px_24px_-12px_rgba(0,0,0,0.6)]")
          : "font-medium text-slate-600 hover:bg-[#0f3460]/[0.06] hover:text-[#0f3460] dark:hover:bg-white/5 dark:hover:text-slate-900",
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]",
          active && "bg-gradient-to-br from-[#1b4a85] to-[#0f3460] text-white shadow-[0_6px_14px_-6px_rgba(15,52,96,0.7)]",
        )}
        aria-hidden="true"
      >
        <item.icon className={cn("h-4 w-4 transition-colors motion-reduce:transition-none", !active && "text-slate-400 group-hover:text-slate-600")} />
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && <span className={cn("rounded px-1.5 py-0.5 text-[10px]", active ? "bg-[#0f3460]/[0.06] text-[#0f3460] dark:bg-blue-400/15 dark:text-blue-200" : "bg-slate-100 text-slate-500")}>{item.badge}</span>}
      {active && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />}
    </Link>
  )
}

/**
 * Lien d'une catégorie, posé sur le curseur bleu glissant de `NavCategories`. `onSlider` : le curseur est sous ce lien
 * (texte blanc). `sliderReady` : le curseur est mesuré et visible ; avant (rendu serveur, première peinture), le lien
 * actif peint lui-même le même fond bleu, pour qu'aucun changement ne soit visible à l'arrivée du curseur.
 */
function SliderNavLink({ item, active, onSlider, sliderReady, onNavigate, onHover, touch }: {
  item: NavItem; active: boolean; onSlider: boolean; sliderReady: boolean
  onNavigate?: () => void; onHover: (href: string) => void; touch: boolean
}) {
  const raised = onSlider || (active && !sliderReady)
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      onPointerEnter={() => onHover(item.href)}
      onFocus={() => onHover(item.href)}
      data-nav-href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative z-[1] flex items-center gap-2.5 rounded-xl px-1.5 text-[13.5px] tracking-[-0.005em] outline-none",
        "transition-colors duration-200 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-blue-500/60",
        touch ? "h-11" : "h-10",
        raised ? "font-semibold text-white" : active ? "font-semibold text-[#0f3460] dark:text-blue-200" : "font-medium text-slate-600",
        active && !sliderReady && SLIDER_SURFACE,
      )}
    >
      <span
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] transition-colors duration-200 motion-reduce:transition-none",
          raised ? "bg-white/20" : active && "bg-[#0f3460]/10 text-[#0f3460] dark:bg-blue-400/15 dark:text-blue-200",
        )}
        aria-hidden="true"
      >
        {(raised || active) && <item.icon className="h-4 w-4" />}
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && <span className={cn("rounded px-1.5 py-0.5 text-[10px]", raised ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500")}>{item.badge}</span>}
      {raised && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/80" aria-hidden="true" />}
    </Link>
  )
}

/** Curseur : dégradé bleu Planificator et ombre bleue portée. */
const SLIDER_SURFACE = cn("bg-gradient-to-br from-[#1b4a85] to-[#0f3460]", SHADOW_SLIDER)

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

  // Curseur bleu glissant : repose sur le lien actif, suit le lien survolé ou qui a le focus, revient au lien actif
  // quand le pointeur ou le focus quitte le menu. Position mesurée dans le conteneur, remesurée quand sa taille change
  // (catégorie repliée / ouverte, police chargée). Mouvement coupé si `prefers-reduced-motion`.
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredHref, setHoveredHref] = useState<string | null>(null)
  const [slider, setSlider] = useState<{ top: number; height: number } | null>(null)
  const [sliderMoves, setSliderMoves] = useState(false)
  const targetHref = hoveredHref ?? activeHref
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const target = targetHref ? container.querySelector<HTMLElement>(`[data-nav-href="${CSS.escape(targetHref)}"]`) : null
      const rect = target?.getBoundingClientRect()
      if (!target || !rect || rect.height === 0) { setSlider(null); return }
      const top = rect.top - container.getBoundingClientRect().top
      setSlider((previous) => (previous && previous.top === top && previous.height === rect.height ? previous : { top, height: rect.height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [targetHref, open])
  // Première position sans glissement ; les suivantes glissent.
  useEffect(() => {
    if (!slider || sliderMoves) return
    const frame = requestAnimationFrame(() => setSliderMoves(true))
    return () => cancelAnimationFrame(frame)
  }, [slider, sliderMoves])
  const sliderReady = slider !== null

  return (
    <div
      ref={containerRef}
      className="relative space-y-0.5"
      onPointerLeave={() => setHoveredHref(null)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoveredHref(null) }}
    >
      <span
        aria-hidden="true"
        data-nav-slider=""
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-0 rounded-xl",
          SLIDER_SURFACE,
          sliderMoves && "transition-[transform,height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          sliderReady ? "opacity-100" : "opacity-0",
        )}
        style={slider ? { transform: `translateY(${slider.top}px)`, height: slider.height } : undefined}
      />
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
                  ? cn(
                      "mt-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#0f3460] hover:text-[#0a2447] dark:text-blue-200 dark:hover:text-blue-100",
                      // Relief gravé : reflet clair sous la lettre, ombre bleu foncé au-dessus (aucun en sombre).
                      "[text-shadow:0_1px_0_rgba(255,255,255,0.95),0_-1px_0_rgba(15,52,96,0.12)] dark:[text-shadow:none]",
                      touch ? "h-11" : "h-8",
                    )
                  : cn("text-[13.5px] tracking-[-0.005em] hover:bg-white/70 dark:hover:bg-white/5", touch ? "h-11" : "h-9",
                      containsActive ? "bg-[#0f3460]/[0.06] font-semibold text-slate-900 hover:bg-[#0f3460]/10 dark:bg-blue-400/15 dark:hover:bg-blue-400/20" : "font-medium text-slate-600"),
              )}
            >
              {!expanded && (
                <category.icon className={cn("h-[18px] w-[18px] shrink-0", containsActive ? "text-[#0f3460] dark:text-blue-300" : "text-slate-400")} aria-hidden="true" />
              )}
              <span className="flex-1 text-left">{category.label}</span>
              {!expanded && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#0f3460]/10 px-2 text-[11px] font-semibold text-[#0f3460] dark:bg-blue-400/15 dark:text-blue-200" aria-hidden="true">
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
                  <SliderNavLink
                    item={item}
                    active={item.href === activeHref}
                    onSlider={sliderReady && item.href === targetHref}
                    sliderReady={sliderReady}
                    onNavigate={onNavigate}
                    onHover={setHoveredHref}
                    touch={touch}
                  />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
