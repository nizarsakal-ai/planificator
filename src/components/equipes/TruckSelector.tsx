"use client"
import { useState } from "react"
import { Truck, Pencil, User } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { VehicleForm } from "@/components/vehicules/VehicleForm"
import { toTruckPayload, vehicleOptionLabel, vehicleToFormValues, type VehicleFormValues } from "@/lib/vehicules/vehicules-view"

interface TruckData {
  id: string
  matricule: string
  marque?: string | null
  modele?: string | null
  chauffeurId?: string | null
  teamId: string | null
  teamName?: string | null
}
interface Member { id: string; name: string }
interface Props {
  teamId: string
  currentTruck: TruckData | null
  allTrucks: TruckData[]
  members: Member[]
}

/** « AB-123-CD — VW Crafter » : marque + modèle ; une ancienne marque seule (« VW Crafter ») reste affichée telle quelle. */
const truckLabel = (t: TruckData) => vehicleOptionLabel(t)

export function TruckSelector({ teamId, currentTruck, allTrucks, members }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

  const patchTruck = async (truckId: string, body: Record<string, unknown>) => {
    const res = await fetch("/api/trucks/" + truckId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return res
  }

  /** Affiche l'erreur serveur (ex. équipe archivée, chauffeur inactif, véhicule archivé). */
  const reportFailure = async (res: Response): Promise<boolean> => {
    if (res.ok) return true
    const err = await res.json().catch(() => ({}))
    toast.error(err.error ?? "Erreur")
    return false
  }

  const assign = async (truckId: string): Promise<boolean> => {
    setLoading(true)
    let ok = true
    if (truckId) {
      ok = await reportFailure(await patchTruck(truckId, { teamId }))
    } else if (currentTruck) {
      ok = await reportFailure(await patchTruck(currentTruck.id, { teamId: null }))
    }
    router.refresh()
    setLoading(false)
    return ok
  }

  const setChauffeur = async (chauffeurId: string) => {
    if (!currentTruck) return
    setLoading(true)
    await reportFailure(await patchTruck(currentTruck.id, { chauffeurId: chauffeurId || null }))
    router.refresh()
    setLoading(false)
  }

  const addTruck = async (values: VehicleFormValues) => {
    setLoading(true)
    const res = await fetch("/api/trucks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toTruckPayload(values)),
    })
    const truck = await res.json()
    if (truck.id) {
      if (await assign(truck.id)) toast.success("Camion ajouté")
    } else {
      toast.error(truck.error ?? "Erreur")
      setLoading(false)
    }
    setShowAdd(false)
  }

  const openEdit = () => {
    if (!currentTruck) return
    setShowEdit(true)
  }

  const saveEdit = async (values: VehicleFormValues) => {
    if (!currentTruck) return
    setLoading(true)
    const res = await patchTruck(currentTruck.id, toTruckPayload(values))
    if (res.ok) {
      toast.success("Camion modifié")
      setShowEdit(false)
      router.refresh()
    } else {
      const err = await res.json().catch(() => ({}))
      toast.error(err.error ?? "Erreur")
    }
    setLoading(false)
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="flex items-center gap-2 mb-2">
        <Truck className="h-3.5 w-3.5 text-slate-400" />
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Camion</p>
      </div>
      <div className="flex items-center gap-2">
        <select
          disabled={loading}
          value={currentTruck?.id ?? ""}
          onChange={(e) => assign(e.target.value)}
          className="flex-1 text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Aucun camion</option>
          {allTrucks.map(t => {
            const usedByOther = t.teamId && t.teamId !== teamId
            return (
              <option key={t.id} value={t.id}>
                {truckLabel(t)}{usedByOther ? ` (équipe ${t.teamName ?? "autre"})` : ""}
              </option>
            )
          })}
        </select>
        {currentTruck && (
          <button
            onClick={openEdit}
            disabled={loading}
            title="Modifier le camion"
            className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:border-blue-400 hover:text-blue-500 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => { setShowAdd(!showAdd); setShowEdit(false) }}
          className="text-xs px-2 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-500 transition-colors whitespace-nowrap"
        >
          + Nouveau
        </button>
      </div>

      {/* Chauffeur du camion assigné */}
      {currentTruck && !showEdit && (
        <div className="flex items-center gap-2 mt-2">
          <User className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <select
            disabled={loading}
            value={currentTruck.chauffeurId ?? ""}
            onChange={(e) => setChauffeur(e.target.value)}
            className="flex-1 text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Aucun chauffeur</option>
            {members.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Formulaire modification camion existant (formulaire partagé) */}
      {showEdit && currentTruck && (
        <div className="mt-2">
          <VehicleForm
            key={currentTruck.id}
            idPrefix={`team-${teamId}-edit`}
            initialValues={vehicleToFormValues({
              matricule: currentTruck.matricule,
              marque: currentTruck.marque ?? null,
              modele: currentTruck.modele ?? null,
            })}
            submitLabel="Enregistrer"
            submitting={loading}
            onSubmit={saveEdit}
            onCancel={() => setShowEdit(false)}
          />
        </div>
      )}

      {/* Formulaire ajout nouveau camion (formulaire partagé) */}
      {showAdd && (
        <div className="mt-2">
          <VehicleForm
            idPrefix={`team-${teamId}-add`}
            submitLabel="Ajouter"
            submitting={loading}
            onSubmit={addTruck}
            onCancel={() => setShowAdd(false)}
          />
        </div>
      )}
    </div>
  )
}
