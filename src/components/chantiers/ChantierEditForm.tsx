"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Save, Pencil, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateChantier } from "@/lib/actions/chantier.actions"

interface Client {
  id: string
  name: string
}

interface Props {
  worksiteId: string
  defaultValues: {
    name:        string
    description: string
    address:     string
    clientId:    string
    startDate:   string
    endDate:     string
    dailyHours:  number
  }
  clients: Client[]
}

export function ChantierEditForm({ worksiteId, defaultValues, clients }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    const fd = new FormData(e.currentTarget)
    const result = await updateChantier(worksiteId, fd)
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Chantier mis à jour.")
    setEditing(false)
    router.refresh()
  }

  if (!editing) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setEditing(true)}
        className="h-7 text-xs gap-1.5 text-slate-500"
      >
        <Pencil className="h-3 w-3" />
        Modifier
      </Button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mt-2">
      {/* Nom */}
      <div className="space-y-1">
        <Label className="text-xs text-slate-600">Nom *</Label>
        <Input name="name" defaultValue={defaultValues.name} required className="h-8 text-sm" />
      </div>

      {/* Client */}
      <div className="space-y-1">
        <Label className="text-xs text-slate-600">Client *</Label>
        <select
          name="clientId"
          defaultValue={defaultValues.clientId}
          className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm"
          required
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Adresse */}
      <div className="space-y-1">
        <Label className="text-xs text-slate-600">Adresse</Label>
        <Input name="address" defaultValue={defaultValues.address} placeholder="Adresse du chantier" className="h-8 text-sm" />
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-slate-600">Début *</Label>
          <Input name="startDate" type="date" defaultValue={defaultValues.startDate} required className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-slate-600">Fin *</Label>
          <Input name="endDate" type="date" defaultValue={defaultValues.endDate} required className="h-8 text-sm" />
        </div>
      </div>

      {/* Heures / jour */}
      <div className="space-y-1">
        <Label className="text-xs text-slate-600">Heures / jour</Label>
        <Input name="dailyHours" type="number" min="1" max="24" defaultValue={defaultValues.dailyHours} className="h-8 text-sm" />
      </div>

      {/* Description */}
      <div className="space-y-1">
        <Label className="text-xs text-slate-600">Description / Spécificités</Label>
        <textarea
          name="description"
          defaultValue={defaultValues.description}
          rows={5}
          placeholder="Spécificités du chantier…"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="submit" disabled={loading} className="flex-1 h-8 text-sm bg-[#0f3460] hover:bg-[#0f3460]/90 text-white">
          {loading
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Sauvegarde…</>
            : <><Save className="h-3.5 w-3.5 mr-1.5" />Enregistrer</>
          }
        </Button>
        <Button type="button" variant="outline" onClick={() => setEditing(false)} className="h-8 text-sm">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </form>
  )
}
