"use client"

import { useState, useEffect } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { AlertTriangle, Loader2, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { affecterEquipe } from "@/lib/actions/chantier.actions"
import { checkTeamConflict } from "@/lib/actions/assignment.actions"

interface Team {
  id: string
  name: string
}

interface Props {
  worksiteId: string
  teams: Team[]
  worksiteStartDate: string // "YYYY-MM-DD"
  worksiteEndDate: string   // "YYYY-MM-DD"
  nextRelayDate?: string    // "YYYY-MM-DD" — jour suivant la dernière affectation
  lastCoveredDate?: string  // "YYYY-MM-DD" — dernier jour couvert
}

function fmtDateFR(iso: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(new Date(iso))
}

export function AffecterEquipeForm({
  worksiteId,
  teams,
  worksiteStartDate,
  worksiteEndDate,
  nextRelayDate,
  lastCoveredDate,
}: Props) {
  const router = useRouter()
  const [teamId, setTeamId] = useState("")
  const [dateFrom, setDateFrom] = useState(worksiteStartDate)
  const [dateTo, setDateTo] = useState("")
  const [loading, setLoading] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  useEffect(() => {
    if (!teamId || !dateFrom) {
      setConflict(null)
      return
    }
    let cancelled = false
    checkTeamConflict(teamId, dateFrom, worksiteId).then((result) => {
      if (!cancelled) setConflict(result ? result.worksiteName : null)
    })
    return () => { cancelled = true }
  }, [teamId, dateFrom, worksiteId])

  function applyRelayDates() {
    if (!nextRelayDate) return
    setDateFrom(nextRelayDate)
    setDateTo(worksiteEndDate)
  }

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
    try {
      const formData = new FormData()
      formData.append("worksiteId", worksiteId)
      formData.append("teamId", teamId)
      formData.append("dateFrom", dateFrom)
      formData.append("dateTo", dateTo || dateFrom)

      const result = await affecterEquipe(formData)

      if (result?.error) {
        toast.error(<span className="whitespace-pre-line">{result.error}</span>)
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
        setConflict(null)
        router.refresh()
      }
    } catch (err) {
      console.error("affecterEquipe error:", err)
      toast.error("Une erreur est survenue. Veuillez réessayer.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Suggestion de relève */}
      {nextRelayDate && lastCoveredDate && (
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
          <span>
            <ArrowRight className="h-3.5 w-3.5 inline mr-1 shrink-0" />
            Les affectations couvrent jusqu'au <strong>{fmtDateFR(lastCoveredDate)}</strong>.
            Configurer une relève à partir du <strong>{fmtDateFR(nextRelayDate)}</strong> ?
          </span>
          <button
            type="button"
            onClick={applyRelayDates}
            className="shrink-0 font-semibold underline hover:text-blue-900 transition-colors"
          >
            Préremplir
          </button>
        </div>
      )}

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
          <Label className="text-xs text-slate-500">
            Date de fin <span className="text-slate-400">(optionnelle)</span>
          </Label>
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
          <Button
            type="submit"
            disabled={loading}
            className="bg-[#0f3460] hover:bg-[#0a2540] w-full sm:w-auto"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Affecter"}
          </Button>
        </div>
      </div>

      {/* Avertissement conflit */}
      {conflict && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
          <span>
            Cette équipe est déjà affectée au chantier{" "}
            <strong>{conflict}</strong> ce jour-là. Vous pouvez quand même valider.
          </span>
        </div>
      )}

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
