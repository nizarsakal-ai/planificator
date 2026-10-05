"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LayoutGrid, List, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react"
import {
  EMPLOYEE_FUNCTION_LABELS,
  EMPLOYEE_FUNCTIONS,
  EMPLOYEE_STATE_FILTERS,
  EMPLOYEE_STATE_LABELS,
  type EmployeeFilterOption,
  type EmployeeFilters,
  type EmployeeFunction,
  type EmployeeStateFilter,
} from "@/lib/employes/employes-view"

export type EmployeViewMode = "grid" | "list"

const ALL = "__all__"

/** Focus clavier aligné sur le composant Button du design system. */
const FOCUS_RING =
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

interface EmployesToolbarProps {
  state: EmployeeStateFilter
  counts: Record<EmployeeStateFilter, number>
  onStateChange: (state: EmployeeStateFilter) => void
  search: string
  onSearchChange: (search: string) => void
  filters: EmployeeFilters
  onFiltersChange: (filters: EmployeeFilters) => void
  activeFilterCount: number
  onReset: () => void
  teamOptions: EmployeeFilterOption[]
  view: EmployeViewMode
  onViewChange: (view: EmployeViewMode) => void
}

export function EmployesToolbar(props: EmployesToolbarProps) {
  const {
    state,
    counts,
    onStateChange,
    search,
    onSearchChange,
    filters,
    onFiltersChange,
    activeFilterCount,
    onReset,
    teamOptions,
    view,
    onViewChange,
  } = props

  const teamLabel = filters.teamId ? teamOptions.find((o) => o.id === filters.teamId)?.label ?? null : null
  const fonctionLabel = filters.fonction ? EMPLOYEE_FUNCTION_LABELS[filters.fonction] : null

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {/* Onglets Actifs / Archivés / Tous */}
        <div role="group" aria-label="Filtrer par état" className="flex self-start gap-1 border-b border-slate-200">
          {EMPLOYEE_STATE_FILTERS.map((id) => {
            const selected = state === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => onStateChange(id)}
                className={`-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors ${FOCUS_RING} ${
                  selected
                    ? "border-blue-600 text-blue-700"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
                }`}
              >
                {EMPLOYEE_STATE_LABELS[id]}
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

        {/* Recherche + Filtres */}
        <div className="flex flex-1 items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Rechercher un nom, une fonction, une équipe…"
              aria-label="Rechercher un employé"
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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className={`h-10 shrink-0 gap-2 px-3 ${activeFilterCount > 0 ? "border-[#0f3460]/40 text-[#0f3460]" : ""}`}
                aria-label={
                  activeFilterCount > 0
                    ? `Filtres (${activeFilterCount} actif${activeFilterCount > 1 ? "s" : ""})`
                    : "Filtres"
                }
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden sm:inline">Filtres</span>
                {activeFilterCount > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[#0f3460] px-1.5 text-[11px] font-semibold text-white">
                    {activeFilterCount}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[min(16rem,calc(100vw-2rem))]">
              <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Filtrer
              </DropdownMenuLabel>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span className="flex-1 truncate">Fonction</span>
                  {fonctionLabel && <span className="max-w-[7rem] truncate text-xs text-slate-500">{fonctionLabel}</span>}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-60">
                  <DropdownMenuRadioGroup
                    value={filters.fonction ?? ALL}
                    onValueChange={(v) =>
                      onFiltersChange({ ...filters, fonction: v === ALL ? null : (v as EmployeeFunction) })
                    }
                  >
                    <DropdownMenuRadioItem value={ALL}>Toutes les fonctions</DropdownMenuRadioItem>
                    {EMPLOYEE_FUNCTIONS.map((f) => (
                      <DropdownMenuRadioItem key={f} value={f}>
                        {EMPLOYEE_FUNCTION_LABELS[f]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={teamOptions.length === 0}>
                  <span className="flex-1 truncate">Équipe</span>
                  {teamLabel && <span className="max-w-[7rem] truncate text-xs text-slate-500">{teamLabel}</span>}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 w-60 overflow-y-auto">
                  <DropdownMenuRadioGroup
                    value={filters.teamId ?? ALL}
                    onValueChange={(v) => onFiltersChange({ ...filters, teamId: v === ALL ? null : v })}
                  >
                    <DropdownMenuRadioItem value={ALL}>Toutes les équipes</DropdownMenuRadioItem>
                    {teamOptions.map((o) => (
                      <DropdownMenuRadioItem key={o.id} value={o.id}>
                        <span className="truncate">{o.label}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={activeFilterCount === 0} onSelect={onReset}>
                <RotateCcw className="h-4 w-4" />
                Réinitialiser les filtres
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Filtres actifs + mode d'affichage */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {fonctionLabel && (
            <ActiveChip label={`Fonction : ${fonctionLabel}`} onRemove={() => onFiltersChange({ ...filters, fonction: null })} />
          )}
          {teamLabel && (
            <ActiveChip label={`Équipe : ${teamLabel}`} onRemove={() => onFiltersChange({ ...filters, teamId: null })} />
          )}
        </div>
        <div role="group" aria-label="Mode d'affichage" className="ml-auto flex items-center gap-1 bg-slate-100 rounded-lg p-1">
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
              className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${FOCUS_RING} ${
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

function ActiveChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-slate-200 bg-white py-0.5 pl-2.5 pr-1 text-xs text-slate-700">
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Retirer ${label}`}
        className={`rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 ${FOCUS_RING}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
