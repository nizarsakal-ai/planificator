"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Truck, Plus, Pencil, Trash2, User, Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface TeamOption {
  id: string
  name: string
}
interface EmployeeOption {
  id: string
  firstName: string
  lastName: string
}
interface TruckItem {
  id: string
  matricule: string
  marque: string | null
  team: { id: string; name: string; color: string | null } | null
  chauffeur: { id: string; firstName: string; lastName: string } | null
}
interface Props {
  trucks: TruckItem[]
  teams: TeamOption[]
  employees: EmployeeOption[]
}

export function VehiculesView({ trucks, teams, employees }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [matricule, setMatricule] = useState("")
  const [marque, setMarque] = useState("")

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

  const addTruck = async () => {
    if (!matricule.trim()) return
    setLoading(true)
    const res = await fetch("/api/trucks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matricule: matricule.trim(), marque: marque.trim() }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success("Véhicule ajouté")
      setShowAdd(false)
      setMatricule("")
      setMarque("")
      router.refresh()
    } else {
      toast.error(data.error ?? "Erreur")
    }
    setLoading(false)
  }

  const openEdit = (t: TruckItem) => {
    setEditId(t.id)
    setMatricule(t.matricule)
    setMarque(t.marque ?? "")
  }

  const saveEdit = async () => {
    if (!editId || !matricule.trim()) return
    const ok = await patchTruck(editId, {
      matricule: matricule.trim(),
      marque: marque.trim(),
    })
    if (ok) {
      toast.success("Véhicule modifié")
      setEditId(null)
      setMatricule("")
      setMarque("")
    }
  }

  const deleteTruck = async (t: TruckItem) => {
    if (!confirm(`Supprimer le véhicule ${t.matricule} ?`)) return
    setLoading(true)
    const res = await fetch("/api/trucks/" + t.id, { method: "DELETE" })
    if (res.ok) {
      toast.success("Véhicule supprimé")
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Véhicules</h1>
          <p className="text-sm text-slate-500 mt-1">
            {trucks.length} véhicule{trucks.length > 1 ? "s" : ""} dans le parc
          </p>
        </div>
        <Button
          onClick={() => { setShowAdd(true); setEditId(null); setMatricule(""); setMarque("") }}
          className="bg-[#0f3460] hover:bg-[#0a2540] gap-2"
        >
          <Plus className="h-4 w-4" />
          Nouveau véhicule
        </Button>
      </div>

      {/* Liste */}
      {trucks.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Truck className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun véhicule pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouveau véhicule&quot; pour commencer.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {trucks.map((t) => (
            <Card key={t.id} className="overflow-hidden hover:shadow-md transition-shadow">
              <div
                className="h-1.5 w-full"
                style={{ backgroundColor: t.team?.color ?? "#94a3b8" }}
              />
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                      <Truck className="h-5 w-5 text-slate-500" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-slate-900">{t.matricule}</h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {t.marque ?? "Marque non renseignée"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={t.team ? "default" : "secondary"}>
                      {t.team ? t.team.name : "Non affecté"}
                    </Badge>
                    <button
                      onClick={() => openEdit(t)}
                      disabled={loading}
                      title="Modifier le véhicule"
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:border-blue-400 hover:text-blue-500 transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => deleteTruck(t)}
                      disabled={loading}
                      title="Supprimer le véhicule"
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:border-red-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Affectation équipe */}
                <div className="flex items-center gap-2 mb-2">
                  <Layers className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  <select
                    disabled={loading}
                    value={t.team?.id ?? ""}
                    onChange={(e) => patchTruck(t.id, { teamId: e.target.value || null })}
                    className="flex-1 text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Aucune équipe</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ))}
                  </select>
                </div>

                {/* Affectation chauffeur */}
                <div className="flex items-center gap-2">
                  <User className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                  <select
                    disabled={loading}
                    value={t.chauffeur?.id ?? ""}
                    onChange={(e) => patchTruck(t.id, { chauffeurId: e.target.value || null })}
                    className="flex-1 text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Aucun chauffeur</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.firstName} {e.lastName}
                      </option>
                    ))}
                  </select>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Dialog ajout / modification */}
      {(showAdd || editId) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => { setShowAdd(false); setEditId(null) }}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 z-10">
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-slate-900">
                {editId ? "Modifier le véhicule" : "Nouveau véhicule"}
              </h2>
              <p className="text-sm text-slate-500 mt-1">
                Immatriculation et marque du véhicule.
              </p>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Immatriculation (ex: AB-123-CD)"
                value={matricule}
                onChange={(e) => setMatricule(e.target.value.toUpperCase())}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                placeholder="Marque / modèle (ex: VW Crafter)"
                value={marque}
                onChange={(e) => setMarque(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex gap-2 pt-1">
                <Button
                  onClick={editId ? saveEdit : addTruck}
                  disabled={loading || !matricule.trim()}
                  className="bg-[#0f3460] hover:bg-[#0a2540]"
                >
                  {editId ? "Enregistrer" : "Ajouter"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setShowAdd(false); setEditId(null) }}
                  disabled={loading}
                >
                  Annuler
                </Button>
              </div>
            </div>
            <button
              onClick={() => { setShowAdd(false); setEditId(null) }}
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
