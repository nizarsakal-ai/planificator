"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateEquipe } from "@/lib/actions/equipe.actions"

const COLORS = [
  "#0f3460", "#e63946", "#2a9d8f", "#e9c46a",
  "#f4a261", "#264653", "#6d6875", "#457b9d",
]

interface Employee {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
}

interface Props {
  teamId: string
  defaultValues: {
    name: string
    color: string
    leaderId: string
  }
  employees: Employee[]
}

export function EquipeEditForm({ teamId, defaultValues, employees }: Props) {
  const router = useRouter()
  const [loading, setLoading]     = useState(false)
  const [color, setColor]         = useState(defaultValues.color || COLORS[0])
  const [leaderId, setLeaderId]   = useState(defaultValues.leaderId)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    const fd = new FormData(e.currentTarget)
    fd.set("color", color)
    fd.set("leaderId", leaderId)
    const result = await updateEquipe(teamId, fd)
    setLoading(false)
    if (result?.error) { toast.error(result.error); return }
    toast.success("Équipe mise à jour.")
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Nom */}
      <div className="space-y-1.5">
        <Label className="text-xs text-slate-600">Nom de l'équipe *</Label>
        <Input name="name" defaultValue={defaultValues.name} required className="h-9 text-sm" />
      </div>

      {/* Couleur */}
      <div className="space-y-1.5">
        <Label className="text-xs text-slate-600">Couleur</Label>
        <div className="flex gap-2 flex-wrap">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-7 h-7 rounded-full border-2 transition-all"
              style={{
                backgroundColor: c,
                borderColor: color === c ? "#000" : "transparent",
                transform: color === c ? "scale(1.2)" : "scale(1)",
              }}
            />
          ))}
        </div>
      </div>

      {/* Chef d'équipe */}
      <div className="space-y-1.5">
        <Label className="text-xs text-slate-600">Chef d'équipe *</Label>
        <select
          value={leaderId}
          onChange={(e) => setLeaderId(e.target.value)}
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.firstName} {emp.lastName}{emp.jobTitle ? ` — ${emp.jobTitle}` : ""}
            </option>
          ))}
        </select>
      </div>

      <Button
        type="submit"
        disabled={loading}
        className="w-full h-9 text-sm bg-[#0f3460] hover:bg-[#0f3460]/90 text-white"
      >
        {loading
          ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sauvegarde…</>
          : <><Save className="h-4 w-4 mr-2" />Enregistrer</>
        }
      </Button>
    </form>
  )
}
