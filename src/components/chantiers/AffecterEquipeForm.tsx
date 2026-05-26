"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { affecterEquipe } from "@/lib/actions/chantier.actions"

interface Team {
  id: string
  name: string
}

interface Props {
  worksiteId: string
  teams: Team[]
}

export function AffecterEquipeForm({ worksiteId, teams }: Props) {
  const router = useRouter()
  const [teamId, setTeamId] = useState("")
  const [date, setDate] = useState("")
  const [loading, setLoading] = useState(false)

  const today = new Date().toISOString().split("T")[0]

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!teamId || !date) { toast.error("Sélectionnez une équipe et une date."); return }

    setLoading(true)
    const formData = new FormData()
    formData.append("worksiteId", worksiteId)
    formData.append("teamId", teamId)
    formData.append("date", date)

    const result = await affecterEquipe(formData)
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success("Équipe affectée avec succès !")
      setTeamId("")
      setDate("")
      router.refresh()
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
      <div className="flex-1 space-y-1">
        <Label className="text-xs text-slate-500">Équipe</Label>
        <select
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">-- Choisir une équipe --</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 space-y-1">
        <Label className="text-xs text-slate-500">Date</Label>
        <Input
          type="date"
          min={today}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      <div className="flex items-end">
        <Button type="submit" disabled={loading} className="bg-[#0f3460] hover:bg-[#0a2540] w-full sm:w-auto">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Affecter"}
        </Button>
      </div>
    </form>
  )
}
