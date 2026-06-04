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
  worksiteStartDate: string // "YYYY-MM-DD"
  worksiteEndDate: string   // "YYYY-MM-DD"
}

export function AffecterEquipeForm({ worksiteId, teams, worksiteStartDate, worksiteEndDate }: Props) {
  const router = useRouter()
  const [teamId, setTeamId] = useState("")
  const [dateFrom, setDateFrom] = useState(worksiteStartDate)
  const [dateTo, setDateTo] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!teamId || !dateFrom) {
      toast.error("Sélectionnez une équipe et une date de début.")
      return
    }
    if (dateTo && dateTo < dateFrom) {
      toast.error("La date de fin doit être après la date de début.")
      return
    }

    setLoading(true)
    const formData = new FormData()
    formData.append("worksiteId", worksiteId)
    formData.append("teamId", teamId)
    formData.append("dateFrom", dateFrom)
    formData.append("dateTo", dateTo || dateFrom)

    const result = await affecterEquipe(formData)
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      const count = result?.count ?? 1
      toast.success(
        count > 1
          ? `${count} affectations créées avec succès !`
          : "Équipe affectée avec succès !"
      )
      setTeamId("")
      setDateFrom("")
      setDateTo("")
      router.refresh()
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Équipe */}
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

        {/* Date de début */}
        <div className="flex-1 space-y-1">
          <Label className="text-xs text-slate-500">Date de début</Label>
          <Input
            type="date"
            min={worksiteStartDate}
            max={worksiteEndDate}
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value)
              if (dateTo && e.target.value > dateTo) setDateTo("")
            }}
          />
        </div>

        {/* Date de fin */}
        <div className="flex-1 space-y-1">
          <Label className="text-xs text-slate-500">Date de fin <span className="text-slate-400">(optionnelle)</span></Label>
          <Input
            type="date"
            min={dateFrom || worksiteStartDate}
            max={worksiteEndDate}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            disabled={!dateFrom}
          />
        </div>

        <div className="flex items-end">
          <Button type="submit" disabled={loading} className="bg-[#0f3460] hover:bg-[#0a2540] w-full sm:w-auto">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Affecter"}
          </Button>
        </div>
      </div>

      {/* Récap jours si plage sélectionnée */}
      {dateFrom && dateTo && dateTo > dateFrom && (
        <p className="text-xs text-slate-400">
          {(() => {
            const from = new Date(dateFrom)
            const to   = new Date(dateTo)
            const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1
            return `${days} jour${days > 1 ? "s" : ""} d'affectation`
          })()}
        </p>
      )}
    </form>
  )
}
