"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Truck, Plus, SearchX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { VehicleForm } from "@/components/vehicules/VehicleForm"
import { VehiculeCard, type VehicleEmployeeOption, type VehicleTeamOption } from "@/components/vehicules/VehiculeCard"
import { VehiculesStats } from "@/components/vehicules/VehiculesStats"
import { VehiculesToolbar, type VehiculeViewMode } from "@/components/vehicules/VehiculesToolbar"
import {
  DEFAULT_VEHICLE_FILTERS,
  DEFAULT_VEHICLE_QUERY,
  applyVehicleView,
  computeVehicleStats,
  countActiveFilters,
  driverFilterOptions,
  teamFilterOptions,
  toTruckPayload,
  vehicleToFormValues,
  type VehicleFilters,
  type VehicleFormValues,
  type VehicleSort,
  type VehicleTab,
  type VehicleViewItem,
} from "@/lib/vehicules/vehicules-view"

interface Props {
  trucks: VehicleViewItem[]
  teams: VehicleTeamOption[]
  employees: VehicleEmployeeOption[]
}

type Dialog = { mode: "create" } | { mode: "edit"; id: string } | null

export function VehiculesView({ trucks, teams, employees }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [tab, setTab] = useState<VehicleTab>(DEFAULT_VEHICLE_QUERY.tab)
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState<VehicleFilters>(DEFAULT_VEHICLE_FILTERS)
  const [sort, setSort] = useState<VehicleSort>(DEFAULT_VEHICLE_QUERY.sort)
  const [view, setView] = useState<VehiculeViewMode>("grid")

  const stats = useMemo(() => computeVehicleStats(trucks), [trucks])
  const teamOptions = useMemo(() => teamFilterOptions(trucks), [trucks])
  const driverOptions = useMemo(() => driverFilterOptions(trucks), [trucks])
  const { items, counts } = useMemo(
    () => applyVehicleView(trucks, { tab, search, filters, sort }),
    [trucks, tab, search, filters, sort]
  )
  const activeFilterCount = countActiveFilters(filters)
  const hasCriteria = search.trim() !== "" || activeFilterCount > 0
  const editing = dialog?.mode === "edit" ? trucks.find((t) => t.id === dialog.id) ?? null : null

  const resetFilters = () => {
    setSearch("")
    setFilters(DEFAULT_VEHICLE_FILTERS)
  }

  const patchTruck = async (truckId: string, body: Record<string, unknown>) => {
    setLoading(true)
    const res = await fetch("/api/trucks/" + truckId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? "Erreur")
    }
    router.refresh()
    setLoading(false)
    return res.ok
  }

  const addTruck = async (values: VehicleFormValues) => {
    setLoading(true)
    const res = await fetch("/api/trucks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toTruckPayload(values)),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success("Véhicule ajouté")
      setDialog(null)
      router.refresh()
    } else {
      toast.error(data.error ?? "Erreur")
    }
    setLoading(false)
  }

  const saveEdit = async (values: VehicleFormValues) => {
    if (!editing) return
    const ok = await patchTruck(editing.id, toTruckPayload(values))
    if (ok) {
      toast.success("Véhicule modifié")
      setDialog(null)
    }
  }

  // Archivage / restauration : jamais de suppression physique, l'historique est conservé.
  const setArchived = async (t: VehicleViewItem, archive: boolean) => {
    if (
      archive &&
      !confirm(
        `Archiver le véhicule ${t.matricule} ?\nIl sera retiré de son équipe et de son chauffeur. L'historique est conservé.`
      )
    )
      return
    setLoading(true)
    const res = await fetch(`/api/trucks/${t.id}/${archive ? "archive" : "restore"}`, { method: "POST" })
    if (res.ok) {
      toast.success(archive ? "Véhicule archivé" : "Véhicule restauré")
    } else {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? "Erreur")
    }
    router.refresh()
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Véhicules</h1>
          <p className="text-sm text-slate-500 mt-1">
            Gérez votre parc : identité, affectations aux équipes et aux chauffeurs, historique.
          </p>
        </div>
        <Button onClick={() => setDialog({ mode: "create" })} className="bg-[#0f3460] hover:bg-[#0a2540] gap-2 shrink-0">
          <Plus className="h-4 w-4" />
          Nouveau véhicule
        </Button>
      </div>

      {trucks.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Truck className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun véhicule pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Nouveau véhicule&quot; pour commencer.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <VehiculesStats stats={stats} />
          <VehiculesToolbar
            tab={tab}
            counts={counts}
            onTabChange={setTab}
            search={search}
            onSearchChange={setSearch}
            filters={filters}
            onFiltersChange={setFilters}
            activeFilterCount={activeFilterCount}
            onReset={resetFilters}
            teamOptions={teamOptions}
            driverOptions={driverOptions}
            sort={sort}
            onSortChange={setSort}
            view={view}
            onViewChange={setView}
          />

          {items.length === 0 ? (
            <Card>
              <CardContent className="py-14 text-center">
                <SearchX className="h-9 w-9 text-slate-200 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">
                  {hasCriteria
                    ? "Aucun véhicule ne correspond à votre recherche."
                    : tab === "archived"
                      ? "Aucun véhicule archivé."
                      : "Aucun véhicule actif."}
                </p>
                {hasCriteria && (
                  <Button variant="outline" size="sm" className="mt-3" onClick={resetFilters}>
                    Effacer la recherche et les filtres
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className={view === "grid" ? "grid grid-cols-1 lg:grid-cols-2 gap-5" : "space-y-3"}>
              {items.map((t) => (
                <VehiculeCard
                  key={t.id}
                  truck={t}
                  teams={teams}
                  employees={employees}
                  layout={view}
                  loading={loading}
                  historyOpen={historyId === t.id}
                  onToggleHistory={() => setHistoryId(historyId === t.id ? null : t.id)}
                  onEdit={() => setDialog({ mode: "edit", id: t.id })}
                  onArchive={() => setArchived(t, true)}
                  onRestore={() => setArchived(t, false)}
                  onAssign={(body) => patchTruck(t.id, body)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Dialog ajout / modification (formulaire partagé) */}
      {(dialog?.mode === "create" || editing) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDialog(null)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "Modifier le véhicule" : "Nouveau véhicule"}
            className="relative bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 z-10"
          >
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-slate-900">
                {editing ? "Modifier le véhicule" : "Nouveau véhicule"}
              </h2>
              <p className="text-sm text-slate-500 mt-1">Immatriculation, marque et modèle du véhicule.</p>
            </div>
            <VehicleForm
              key={editing?.id ?? "create"}
              idPrefix="vehicules"
              initialValues={editing ? vehicleToFormValues(editing) : undefined}
              submitLabel={editing ? "Enregistrer" : "Ajouter"}
              submitting={loading}
              onSubmit={editing ? saveEdit : addTruck}
              onCancel={() => setDialog(null)}
            />
            <button
              type="button"
              onClick={() => setDialog(null)}
              aria-label="Fermer"
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 text-xl leading-none"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
