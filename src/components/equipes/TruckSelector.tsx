"use client"
import { useState } from "react"
import { Truck, Pencil, User } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

interface TruckData {
  id: string
  matricule: string
  marque?: string | null
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

const truckLabel = (t: TruckData) =>
  t.marque ? `${t.matricule} — ${t.marque}` : t.matricule

export function TruckSelector({ teamId, currentTruck, allTrucks, members }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [newMatricule, setNewMatricule] = useState("")
  const [newMarque, setNewMarque] = useState("")
  const [editMatricule, setEditMatricule] = useState("")
  const [editMarque, setEditMarque] = useState("")

  const patchTruck = async (truckId: string, body: Record<string, unknown>) => {
    const res = await fetch("/api/trucks/" + truckId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return res
  }

  const assign = async (truckId: string) => {
    setLoading(true)
    if (truckId) {
      await patchTruck(truckId, { teamId })
    } else if (currentTruck) {
      await patchTruck(currentTruck.id, { teamId: null })
    }
    router.refresh()
    setLoading(false)
  }

  const setChauffeur = async (chauffeurId: string) => {
    if (!currentTruck) return
    setLoading(true)
    await patchTruck(currentTruck.id, { chauffeurId: chauffeurId || null })
    router.refresh()
    setLoading(false)
  }

  const addTruck = async () => {
    if (!newMatricule.trim()) return
    setLoading(true)
    const res = await fetch("/api/trucks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matricule: newMatricule.trim(), marque: newMarque.trim() }),
    })
    const truck = await res.json()
    if (truck.id) {
      await assign(truck.id)
      toast.success("Camion ajouté")
    } else {
      toast.error(truck.error ?? "Erreur")
      setLoading(false)
    }
    setNewMatricule("")
    setNewMarque("")
    setShowAdd(false)
  }

  const openEdit = () => {
    if (!currentTruck) return
    setEditMatricule(currentTruck.matricule)
    setEditMarque(currentTruck.marque ?? "")
    setShowEdit(true)
  }

  const saveEdit = async () => {
    if (!currentTruck || !editMatricule.trim()) return
    setLoading(true)
    const res = await patchTruck(currentTruck.id, {
      matricule: editMatricule.trim(),
      marque: editMarque.trim(),
    })
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

      {/* Formulaire modification camion existant */}
      {showEdit && currentTruck && (
        <div className="mt-2 space-y-2">
          <input
            type="text"
            placeholder="Immatriculation (ex: AB-123-CD)"
            value={editMatricule}
            onChange={(e) => setEditMatricule(e.target.value.toUpperCase())}
            className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="text"
            placeholder="Marque / modèle (ex: VW Crafter)"
            value={editMarque}
            onChange={(e) => setEditMarque(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex gap-2">
            <button
              onClick={saveEdit}
              disabled={loading || !editMatricule.trim()}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Enregistrer
            </button>
            <button
              onClick={() => setShowEdit(false)}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* Formulaire ajout nouveau camion */}
      {showAdd && (
        <div className="mt-2 space-y-2">
          <input
            type="text"
            placeholder="Immatriculation (ex: AB-123-CD)"
            value={newMatricule}
            onChange={(e) => setNewMatricule(e.target.value.toUpperCase())}
            className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === "Enter" && addTruck()}
          />
          <input
            type="text"
            placeholder="Marque / modèle (ex: VW Crafter)"
            value={newMarque}
            onChange={(e) => setNewMarque(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === "Enter" && addTruck()}
          />
          <div className="flex gap-2">
            <button
              onClick={addTruck}
              disabled={loading || !newMatricule.trim()}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Ajouter
            </button>
            <button
              onClick={() => setShowAdd(false)}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
