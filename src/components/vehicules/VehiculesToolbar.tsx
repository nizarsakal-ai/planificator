"use client"

import { LayoutGrid, List, RotateCcw, Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  NO_DRIVER,
  NO_TEAM,
  VEHICLE_ASSIGNMENT_FILTERS,
  VEHICLE_ASSIGNMENT_LABELS,
  VEHICLE_SORTS,
  VEHICLE_SORT_LABELS,
  VEHICLE_TABS,
  VEHICLE_TAB_LABELS,
  type VehicleAssignmentFilter,
  type VehicleFilterOption,
  type VehicleFilters,
  type VehicleSort,
  type VehicleTab,
} from "@/lib/vehicules/vehicules-view"

export type VehiculeViewMode = "grid" | "list"

const FOCUS_RING =
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
const SELECT =
  "h-10 min-w-0 rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"

interface VehiculesToolbarProps {
  tab: VehicleTab
  counts: Record<VehicleTab, number>
  onTabChange: (tab: VehicleTab) => void
  search: string
  onSearchChange: (search: string) => void
  filters: VehicleFilters
  onFiltersChange: (filters: VehicleFilters) => void
  activeFilterCount: number
  onReset: () => void
  teamOptions: VehicleFilterOption[]
  driverOptions: VehicleFilterOption[]
  sort: VehicleSort
  onSortChange: (sort: VehicleSort) => void
  view: VehiculeViewMode
  onViewChange: (view: VehiculeViewMode) => void
}

export function VehiculesToolbar(props: VehiculesToolbarProps) {
  const {
    tab, counts, onTabChange, search, onSearchChange, filters, onFiltersChange, activeFilterCount, onReset,
    teamOptions, driverOptions, sort, onSortChange, view, onViewChange,
  } = props

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div role="group" aria-label="Filtrer par état" className="flex self-start gap-1 border-b border-slate-200">
          {VEHICLE_TABS.map((id) => {
            const selected = tab === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => onTabChange(id)}
                className={`-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors ${FOCUS_RING} ${
                  selected ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
                }`}
              >
                {VEHICLE_TAB_LABELS[id]}
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

        <div className="flex flex-1 items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Rechercher une immatriculation, une marque, un modèle, une équipe, un chauffeur…"
              aria-label="Rechercher un véhicule"
              className="pl-9 pr-9 bg-white [&::-webkit-search-cancel-button]:hidden"
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
          <div role="group" aria-label="Mode d'affichage" className="flex shrink-0 rounded-lg border border-slate-200 bg-white p-0.5">
            {([["grid", "Mosaïque", LayoutGrid], ["list", "Liste", List]] as const).map(([mode, label, Icon]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                aria-label={label}
                title={label}
                onClick={() => onViewChange(mode)}
                className={`rounded-md p-2 ${FOCUS_RING} ${view === mode ? "bg-slate-100 text-slate-900" : "text-slate-400 hover:text-slate-600"}`}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filtrer par équipe"
          value={filters.teamId ?? ""}
          onChange={(e) => onFiltersChange({ ...filters, teamId: e.target.value || null })}
          className={SELECT}
        >
          <option value="">Toutes les équipes</option>
          <option value={NO_TEAM}>Sans équipe</option>
          {teamOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select
          aria-label="Filtrer par chauffeur"
          value={filters.chauffeurId ?? ""}
          onChange={(e) => onFiltersChange({ ...filters, chauffeurId: e.target.value || null })}
          className={SELECT}
        >
          <option value="">Tous les chauffeurs</option>
          <option value={NO_DRIVER}>Sans chauffeur</option>
          {driverOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          Affectation
          <select
            aria-label="Filtrer par affectation"
            value={filters.assignment}
            onChange={(e) => onFiltersChange({ ...filters, assignment: e.target.value as VehicleAssignmentFilter })}
            className={SELECT}
          >
            {VEHICLE_ASSIGNMENT_FILTERS.map((id) => <option key={id} value={id}>{VEHICLE_ASSIGNMENT_LABELS[id]}</option>)}
          </select>
        </label>
        <select
          aria-label="Trier par"
          value={sort}
          onChange={(e) => onSortChange(e.target.value as VehicleSort)}
          className={`${SELECT} sm:ml-auto`}
        >
          {VEHICLE_SORTS.map((id) => <option key={id} value={id}>Tri : {VEHICLE_SORT_LABELS[id]}</option>)}
        </select>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={onReset}
            className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm text-slate-500 hover:text-slate-800 ${FOCUS_RING}`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Réinitialiser ({activeFilterCount})
          </button>
        )}
      </div>
    </div>
  )
}
