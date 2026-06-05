"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Plus, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { affecterEquipe } from "@/lib/actions/chantier.actions"

interface WorksiteOption {
  id: string
  name: string
  startDate: string
  endDate: string
}

interface Props {
  teamId: string
  teamName: string
  worksites: WorksiteOption[]
  defaultDate: string
}

export function PersonnelAssignForm({ teamId, teamName, worksites, defaultDate }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [worksiteId, setWorksiteId] = useState("")
  const [dateFrom, setDateFrom] = useState(defaultDate)
  const [dateTo, setDateTo] = useState("")
  const [loading, setLoading] = useState(false)

  const selectedWorksite = worksites.find((w) => w.id === worksiteId)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!worksiteId || !dateFrom) {
      toast.error("Sélectionnez un chantier et une date.")
      return
    }

    setLoading(true)
    const fd = new FormData()
    fd.append("worksiteId", worksiteId)
    fd.append("teamId", teamId)
    fd.append("dateFrom", dateFrom)
    fd.append("dateTo", dateTo || dateFrom)

    const result = await affecterEquipe(fd)
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      const count = result?.count ?? 1
      toast.success(
        count > 1
          ? `${teamName} affectée sur ${count} jours`
          : `${teamName} affectée avec succès !`
      )
      setOpen(false)
      setWorksiteId("")
      setDateFrom(defaultDate)
      setDateTo("")
      router.refresh()
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-slate-200 text-xs text-slate-400 hover:border-slate-300 hover:text-slate-600 hover:bg-slate-50 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        Affecter au chantier
      </button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 pt-1 border-t border-slate-100">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600">Affecter {teamName}</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Chantier */}
      <div className="space-y-1">
        <Label className="text-[11px] text-slate-500">Chantier</Label>
        <select
          value={worksiteId}
          onChange={(e) => {
            setWorksiteId(e.target.value)
            const ws = worksites.find((w) => w.id === e.target.value)
            if (ws) {
              setDateFrom(defaultDate >= ws.startDate && defaultDate <= ws.endDate
                ? defaultDate
                : ws.startDate
              )
              setDateTo("")
            }
          }}
          className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
          required
        >
          <option value="">-- Choisir un chantier --</option>
          {worksites.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </div>

      {/* Dates */}
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-[11px] text-slate-500">Du</Label>
          <Input
            type="date"
            value={dateFrom}
            min={selectedWorksite?.startDate}
            max={selectedWorksite?.endDate}
            onChange={(e) => {
              setDateFrom(e.target.value)
              if (dateTo && e.target.value > dateTo) setDateTo("")
            }}
            className="h-8 text-xs"
            required
          />
        </div>
        <div className="flex-1 space-y-1">
          <Label className="text-[11px] text-slate-500">Au <span className="text-slate-400">(optionnel)</span></Label>
          <Input
            type="date"
            value={dateTo}
            min={dateFrom || selectedWorksite?.startDate}
            max={selectedWorksite?.endDate}
            onChange={(e) => setDateTo(e.target.value)}
            disabled={!dateFrom}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <Button
        type="submit"
        disabled={loading}
        className="w-full h-8 text-xs bg-[#0f3460] hover:bg-[#0a2540]"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirmer l'affectation"}
      </Button>
    </form>
  )
}
