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
import {
  LayoutGrid,
  LayoutDashboard,
  List,
  Map,
  Search,
  SlidersHorizontal,
  X,
  RotateCcw,
} from "lucide-react"
import {
  CHANTIER_STATE_FILTERS,
  DEFAULT_SORT,
  SORT_LABELS,
  STATE_FILTER_LABELS,
  type ChantierComplementaryFilters,
  type ChantierSort,
  type ChantierStateFilter,
  type FilterOption,
} from "@/lib/chantiers/chantiers-view-filters"
import type { ChantierViewMode } from "./ChantiersResults"

const ALL = "__all__"

const VIEW_MODES: { id: ChantierViewMode; label: string; Icon: typeof LayoutGrid }[] = [
  { id: "grid", label: "Grille", Icon: LayoutGrid },
  { id: "mosaic", label: "Mosaïque", Icon: LayoutDashboard },
  { id: "list", label: "Liste", Icon: List },
  { id: "map", label: "Carte", Icon: Map },
]

/** Focus clavier aligné sur le composant Button du design system. */
const FOCUS_RING =
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

const SORT_ORDER: ChantierSort[] = ["name-asc", "name-desc", "start-asc", "start-desc", "end-asc", "end-desc"]

interface ChantiersFilterBarProps {
  state: ChantierStateFilter
  counts: Record<ChantierStateFilter, number>
  onStateChange: (state: ChantierStateFilter) => void
  search: string
  onSearchChange: (search: string) => void
  filters: ChantierComplementaryFilters
  onFiltersChange: (filters: ChantierComplementaryFilters) => void
  sort: ChantierSort
  onSortChange: (sort: ChantierSort) => void
  activeFilterCount: number
  isSortCustomized: boolean
  onReset: () => void
  clientOptions: FilterOption[]
  personnelOptions: FilterOption[]
  view: ChantierViewMode
  onViewChange: (view: ChantierViewMode) => void
}

function optionLabel(options: FilterOption[], id: string | null): string | null {
  if (!id) return null
  return options.find((o) => o.id === id)?.label ?? null
}

export function ChantiersFilterBar(props: ChantiersFilterBarProps) {
  const {
    state,
    counts,
    onStateChange,
    search,
    onSearchChange,
    filters,
    onFiltersChange,
    sort,
    onSortChange,
    activeFilterCount,
    isSortCustomized,
    onReset,
    clientOptions,
    personnelOptions,
    view,
    onViewChange,
  } = props

  const clientLabel = optionLabel(clientOptions, filters.clientId)
  const employeeLabel = optionLabel(personnelOptions, filters.employeeId)
  const menuBadge = activeFilterCount + (isSortCustomized ? 1 : 0)

  return (
    <div className="space-y-3">
      {/* 1. État */}
      <div
        role="group"
        aria-label="Filtrer par état"
        className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="inline-flex bg-slate-100 rounded-lg p-1 gap-1">
          {CHANTIER_STATE_FILTERS.map((id) => {
            const selected = state === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => onStateChange(id)}
                className={`whitespace-nowrap px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${FOCUS_RING} ${
                  selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {STATE_FILTER_LABELS[id]}
                <span className={`ml-1.5 tabular-nums ${selected ? "text-slate-500" : "text-slate-400"}`}>
                  {counts[id]}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 2. Recherche + 3. Filtres/tri */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Rechercher un chantier, un client, une adresse, une ville…"
            aria-label="Rechercher un chantier"
            className="pl-9 pr-9 bg-white [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              aria-label="Effacer la recherche"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className={`h-10 shrink-0 gap-2 px-3 ${menuBadge > 0 ? "border-slate-400 text-slate-900" : ""}`}
              aria-label={menuBadge > 0 ? `Filtres et tri (${menuBadge} actif${menuBadge > 1 ? "s" : ""})` : "Filtres et tri"}
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">Filtres</span>
              {menuBadge > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900 px-1.5 text-[11px] font-semibold text-white">
                  {menuBadge}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]">
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Trier par
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSortChange(v as ChantierSort)}>
              {SORT_ORDER.map((s) => (
                <DropdownMenuRadioItem key={s} value={s}>
                  {SORT_LABELS[s]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Filtrer
            </DropdownMenuLabel>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={clientOptions.length === 0}>
                <span className="flex-1 truncate">Client</span>
                {clientLabel && <span className="max-w-[7rem] truncate text-xs text-slate-500">{clientLabel}</span>}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-60 overflow-y-auto">
                <DropdownMenuRadioGroup
                  value={filters.clientId ?? ALL}
                  onValueChange={(v) => onFiltersChange({ ...filters, clientId: v === ALL ? null : v })}
                >
                  <DropdownMenuRadioItem value={ALL}>Tous les clients</DropdownMenuRadioItem>
                  {clientOptions.map((o) => (
                    <DropdownMenuRadioItem key={o.id} value={o.id}>
                      <span className="truncate">{o.label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {personnelOptions.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span className="flex-1 truncate">Personnel affecté</span>
                  {employeeLabel && <span className="max-w-[7rem] truncate text-xs text-slate-500">{employeeLabel}</span>}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-72 w-60 overflow-y-auto">
                  <DropdownMenuRadioGroup
                    value={filters.employeeId ?? ALL}
                    onValueChange={(v) => onFiltersChange({ ...filters, employeeId: v === ALL ? null : v })}
                  >
                    <DropdownMenuRadioItem value={ALL}>Tout le personnel</DropdownMenuRadioItem>
                    {personnelOptions.map((o) => (
                      <DropdownMenuRadioItem key={o.id} value={o.id}>
                        <span className="truncate">{o.label}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={menuBadge === 0} onSelect={onReset}>
              <RotateCcw className="h-4 w-4" />
              Réinitialiser les filtres
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Filtres actifs + modes d'affichage */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {clientLabel && (
            <ActiveChip label={`Client : ${clientLabel}`} onRemove={() => onFiltersChange({ ...filters, clientId: null })} />
          )}
          {employeeLabel && (
            <ActiveChip
              label={`Personnel : ${employeeLabel}`}
              onRemove={() => onFiltersChange({ ...filters, employeeId: null })}
            />
          )}
          {isSortCustomized && (
            <ActiveChip label={`Tri : ${SORT_LABELS[sort]}`} onRemove={() => onSortChange(DEFAULT_SORT)} />
          )}
        </div>

        <div role="group" aria-label="Mode d'affichage" className="ml-auto flex bg-slate-100 rounded-lg p-1 gap-1">
          {VIEW_MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              aria-label={label}
              title={label}
              onClick={() => onViewChange(id)}
              className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${FOCUS_RING} ${
                view === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
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
        className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
