"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ArrowUpDown, LayoutGrid, List, Search, SlidersHorizontal, X } from "lucide-react"
import {
  EQUIPE_SORT_LABELS,
  EQUIPE_TAB_LABELS,
  EQUIPE_TABS,
  type EquipeSort,
  type EquipeTab,
  type VehicleFilter,
} from "@/lib/equipes/equipes-view"

export type EquipeViewMode = "grid" | "list"

export const VEHICLE_FILTER_LABELS: Record<VehicleFilter, string> = {
  all: "Tous",
  with: "Avec véhicule",
  without: "Sans véhicule",
}

/** Focus clavier aligné sur le composant Button du design system. */
const FOCUS_RING =
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

interface EquipesToolbarProps {
  tab: EquipeTab
  counts: Record<EquipeTab, number>
  onTabChange: (tab: EquipeTab) => void
  search: string
  onSearchChange: (search: string) => void
  vehicle: VehicleFilter
  onVehicleChange: (vehicle: VehicleFilter) => void
  sort: EquipeSort
  onSortChange: (sort: EquipeSort) => void
  view: EquipeViewMode
  onViewChange: (view: EquipeViewMode) => void
}

export function EquipesToolbar(props: EquipesToolbarProps) {
  const { tab, counts, onTabChange, search, onSearchChange, vehicle, onVehicleChange, sort, onSortChange, view, onViewChange } =
    props

  return (
    <div className="space-y-3">
      {/* Onglets avec compteurs */}
      <div role="group" aria-label="Filtrer les équipes" className="flex gap-1 overflow-x-auto border-b border-slate-200 min-[1168px]:gap-0.5 2xl:gap-1">
        {EQUIPE_TABS.map((id) => {
          const selected = tab === id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => onTabChange(id)}
              className={`-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 min-[1168px]:px-2 2xl:px-3 text-sm font-medium transition-colors ${FOCUS_RING} ${
                selected
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
              }`}
            >
              {EQUIPE_TAB_LABELS[id]}
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs tabular-nums ${
                  selected ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-400"
                }`}
              >
                {counts[id]}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Recherche */}
        <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Rechercher une équipe, un chef, un membre…"
            aria-label="Rechercher une équipe"
            className="bg-white pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Effacer la recherche"
              className={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600 ${FOCUS_RING}`}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filtre véhicule */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className={`h-10 shrink-0 gap-2 px-3 ${vehicle !== "all" ? "border-[#0f3460]/40 text-[#0f3460]" : ""}`}
              aria-label={`Filtre véhicule : ${VEHICLE_FILTER_LABELS[vehicle]}`}
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">
                Véhicule{vehicle !== "all" ? ` : ${VEHICLE_FILTER_LABELS[vehicle]}` : ""}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Véhicule
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={vehicle} onValueChange={(v) => onVehicleChange(v as VehicleFilter)}>
              {(Object.keys(VEHICLE_FILTER_LABELS) as VehicleFilter[]).map((v) => (
                <DropdownMenuRadioItem key={v} value={v}>
                  {VEHICLE_FILTER_LABELS[v]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Tri */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-10 shrink-0 gap-2 px-3" aria-label={`Trier : ${EQUIPE_SORT_LABELS[sort]}`}>
              <ArrowUpDown className="h-4 w-4" />
              <span className="hidden sm:inline">{EQUIPE_SORT_LABELS[sort]}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-slate-500">Trier</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSortChange(v as EquipeSort)}>
              {(Object.keys(EQUIPE_SORT_LABELS) as EquipeSort[]).map((s) => (
                <DropdownMenuRadioItem key={s} value={s}>
                  {EQUIPE_SORT_LABELS[s]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Mode d'affichage */}
        <div role="group" aria-label="Mode d'affichage" className="ml-auto flex items-center gap-1 rounded-lg bg-slate-100 p-1">
          {([
            { id: "grid", label: "Mosaïque", Icon: LayoutGrid },
            { id: "list", label: "Liste", Icon: List },
          ] as const).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              aria-label={label}
              title={label}
              onClick={() => onViewChange(id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-3 ${FOCUS_RING} ${
                view === id ? "bg-white text-[#0f3460] shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
