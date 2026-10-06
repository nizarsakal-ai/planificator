"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { Layers } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import {
  applyEquipeView,
  DEFAULT_EQUIPE_SORT,
  DEFAULT_EQUIPE_TAB,
  EQUIPE_TAB_LABELS,
  type EquipeSort,
  type EquipeTab,
  type EquipeViewItem,
  type VehicleFilter,
} from "@/lib/equipes/equipes-view"
import { EquipesToolbar, type EquipeViewMode } from "./EquipesToolbar"
import { EquipeCard } from "./EquipeCard"
import { EquipeList } from "./EquipeList"
import type { EquipeTruckOption } from "./EquipeActionsMenu"

interface EquipesViewProps {
  teams: EquipeViewItem[]
  trucks: EquipeTruckOption[]
  canManage: boolean
  /** Rendu initial (tests SSR) — l'état reste ensuite purement client. */
  initialView?: EquipeViewMode
  initialTab?: EquipeTab
}

export function EquipesView({ teams, trucks, canManage, initialView = "grid", initialTab = DEFAULT_EQUIPE_TAB }: EquipesViewProps) {
  const [view, setView] = useState<EquipeViewMode>(initialView)
  const [tab, setTab] = useState<EquipeTab>(initialTab)
  const [search, setSearch] = useState("")
  const [vehicle, setVehicle] = useState<VehicleFilter>("all")
  const [sort, setSort] = useState<EquipeSort>(DEFAULT_EQUIPE_SORT)

  const deferredSearch = useDeferredValue(search)
  const { items, counts } = useMemo(
    () => applyEquipeView(teams, { tab, search: deferredSearch, vehicle, sort }),
    [teams, tab, deferredSearch, vehicle, sort]
  )

  const filtered = deferredSearch.trim() !== "" || vehicle !== "all"

  return (
    <div className="space-y-5">
      <EquipesToolbar
        tab={tab}
        counts={counts}
        onTabChange={setTab}
        search={search}
        onSearchChange={setSearch}
        vehicle={vehicle}
        onVehicleChange={setVehicle}
        sort={sort}
        onSortChange={setSort}
        view={view}
        onViewChange={setView}
      />

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Layers className="mx-auto mb-3 h-8 w-8 text-slate-200" />
            {teams.length === 0 ? (
              <>
                <p className="font-medium text-slate-500">Aucune équipe pour le moment.</p>
                <p className="mt-1 text-sm text-slate-400">Cliquez sur « Nouvelle équipe » pour commencer.</p>
              </>
            ) : (
              <>
                <p className="font-medium text-slate-500">Aucune équipe dans « {EQUIPE_TAB_LABELS[tab]} ».</p>
                {filtered && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("")
                      setVehicle("all")
                    }}
                    className="mt-2 text-sm font-medium text-[#0f3460] underline underline-offset-2"
                  >
                    Effacer la recherche et les filtres
                  </button>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3 min-[1800px]:grid-cols-4">
          {items.map((team) => (
            <EquipeCard key={team.id} team={team} trucks={trucks} canManage={canManage} />
          ))}
        </div>
      ) : (
        <EquipeList teams={items} trucks={trucks} canManage={canManage} />
      )}
    </div>
  )
}
