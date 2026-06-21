"use client"
import { useState } from "react"
import { Truck } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

interface TruckData { id: string; matricule: string; teamId: string | null }
interface Props { teamId: string; currentTruck: TruckData | null; allTrucks: TruckData[] }

export function TruckSelector({ teamId, currentTruck, allTrucks }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [newMatricule, setNewMatricule] = useState("")
  const [showAdd, setShowAdd] = useState(false)
  const available = allTrucks.filter(t => !t.teamId || t.teamId === teamId)

  const assign = async (truckId: string) => {
    setLoading(true)
    if (truckId) {
      await fetch("/api/trucks/" + truckId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      })
    } else if (currentTruck) {
      await fetch("/api/trucks/" + currentTruck.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: null }),
      })
    }
    router.refresh()
    setLoading(false)
  }

  const addTruck = async () => {
    if (!newMatricule.trim()) return
    setLoading(true)
    const res = await fetch("/api/trucks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matricule: newMatricule.trim() }),
    })
    const truck = await res.json()
    if (truck.id) {
      await assign(truck.id)
      toast.success("Camion ajoute")
    } else {
      toast.error(truck.error ?? "Erreur")
      setLoading(false)
    }
    setNewMatricule("")
    setShowAdd(false)
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
          {available.map(t => (
            <option key={t.id} value={t.id}>{t.matricule}</option>
          ))}
        </select>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs px-2 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-500 transition-colors whitespace-nowrap"
        >
          + Nouveau
        </button>
      </div>
      {showAdd && (
        <div className="flex gap-2 mt-2">
          <input
            type="text"
            placeholder="Ex: AB-123-CD"
            value={newMatricule}
            onChange={(e) => setNewMatricule(e.target.value.toUpperCase())}
            className="flex-1 text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === "Enter" && addTruck()}
          />
          <button
            onClick={addTruck}
            disabled={loading || !newMatricule.trim()}
            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            OK
          </button>
        </div>
      )}
    </div>
  )
}
