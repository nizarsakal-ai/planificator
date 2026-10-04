"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { HardHat } from "lucide-react"
import {
  applyChantierView,
  buildChantierSetKey,
  countActiveComplementaryFilters,
  DEFAULT_SORT,
  DEFAULT_STATE_FILTER,
  EMPTY_COMPLEMENTARY_FILTERS,
  STATE_FILTER_LABELS,
  type ChantierComplementaryFilters,
  type ChantierSort,
  type ChantierStateFilter,
  type FilterOption,
} from "@/lib/chantiers/chantiers-view-filters"
import { ChantiersFilterBar } from "./ChantiersFilterBar"
import { ChantiersResults, type ChantierCardData, type ChantierViewMode } from "./ChantiersResults"

interface ChantiersViewProps {
  chantiers: ChantierCardData[]
  clientOptions: FilterOption[]
  personnelOptions: FilterOption[]
}

export function ChantiersView({ chantiers, clientOptions, personnelOptions }: ChantiersViewProps) {
  const [view, setView] = useState<ChantierViewMode>("grid")
  const [state, setState] = useState<ChantierStateFilter>(DEFAULT_STATE_FILTER)
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState<ChantierComplementaryFilters>(EMPTY_COMPLEMENTARY_FILTERS)
  const [sort, setSort] = useState<ChantierSort>(DEFAULT_SORT)

  // La saisie reste fluide ; le filtrage suit avec la valeur différée.
  const deferredSearch = useDeferredValue(search)

  const { items, counts } = useMemo(
    () => applyChantierView(chantiers, { state, search: deferredSearch, filters, sort }),
    [chantiers, state, deferredSearch, filters, sort]
  )

  const activeFilterCount = countActiveComplementaryFilters(filters)
  const isSortCustomized = sort !== DEFAULT_SORT
  const hasNarrowing = deferredSearch.trim() !== "" || activeFilterCount > 0

  const resetFilters = () => {
    setFilters(EMPTY_COMPLEMENTARY_FILTERS)
    setSort(DEFAULT_SORT)
  }

  const mapKey = useMemo(() => buildChantierSetKey(items), [items])

  // Suggestion d'un autre état lorsque l'état courant est vide.
  const fallbackState = (["active", "planned", "unassigned", "done", "all"] as const).find(
    (s) => s !== state && counts[s] > 0
  )

  return (
    <div className="space-y-4">
      <ChantiersFilterBar
        state={state}
        counts={counts}
        onStateChange={setState}
        search={search}
        onSearchChange={setSearch}
        filters={filters}
        onFiltersChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        activeFilterCount={activeFilterCount}
        isSortCustomized={isSortCustomized}
        onReset={resetFilters}
        clientOptions={clientOptions}
        personnelOptions={personnelOptions}
        view={view}
        onViewChange={setView}
      />

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <HardHat className="h-8 w-8 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">
              {hasNarrowing
                ? `Aucun chantier ne correspond dans « ${STATE_FILTER_LABELS[state]} ».`
                : `Aucun chantier dans « ${STATE_FILTER_LABELS[state]} ».`}
            </p>
            {fallbackState && (
              <button
                type="button"
                onClick={() => setState(fallbackState)}
                className="mt-2 text-sm font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900"
              >
                Voir {STATE_FILTER_LABELS[fallbackState]} ({counts[fallbackState]})
              </button>
            )}
          </CardContent>
        </Card>
      ) : (
        <ChantiersResults chantiers={items} view={view} state={state} mapKey={mapKey} />
      )}
    </div>
  )
}
