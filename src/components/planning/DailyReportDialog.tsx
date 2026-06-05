"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { FileText, Loader2 } from "lucide-react"
import { upsertDailyReport } from "@/lib/actions/daily-report.actions"
import type { WeatherCondition } from "@prisma/client"

interface DailyReportDialogProps {
  worksiteId: string
  worksiteName: string
  teamId: string
  date: string // YYYY-MM-DD
  dailyHours: number
  existingReport?: {
    weather: WeatherCondition
    description: string
    issues: string | null
    hoursWorked: number
  } | null
}

const WEATHER_OPTIONS: { value: WeatherCondition; emoji: string; label: string }[] = [
  { value: "SUNNY",   emoji: "☀️",  label: "Ensoleillé" },
  { value: "CLOUDY",  emoji: "⛅",  label: "Nuageux" },
  { value: "RAINY",   emoji: "🌧️", label: "Pluvieux" },
  { value: "STORMY",  emoji: "⛈️", label: "Orageux" },
  { value: "WINDY",   emoji: "💨",  label: "Venteux" },
  { value: "SNOW",    emoji: "❄️",  label: "Neige" },
]

export function DailyReportDialog({
  worksiteId, worksiteName, teamId, date, dailyHours, existingReport
}: DailyReportDialogProps) {
  const [open, setOpen] = useState(false)
  const [weather, setWeather] = useState<WeatherCondition>(existingReport?.weather ?? "SUNNY")
  const [description, setDescription] = useState(existingReport?.description ?? "")
  const [issues, setIssues] = useState(existingReport?.issues ?? "")
  const [hoursWorked, setHoursWorked] = useState(existingReport?.hoursWorked ?? dailyHours)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const fd = new FormData()
    fd.append("worksiteId",  worksiteId)
    fd.append("teamId",      teamId)
    fd.append("date",        date)
    fd.append("weather",     weather)
    fd.append("description", description)
    fd.append("issues",      issues)
    fd.append("hoursWorked", String(hoursWorked))

    startTransition(async () => {
      const result = await upsertDailyReport(fd)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success("Rapport enregistré")
        setOpen(false)
      }
    })
  }

  const formatDate = (d: string) =>
    new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(new Date(d))

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          existingReport
            ? "border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        }`}
      >
        <FileText className="h-3.5 w-3.5" />
        {existingReport ? "Voir / modifier le rapport" : "Rédiger le rapport journalier"}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-5 pt-5 pb-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900 text-sm">Rapport journalier</h2>
          <p className="text-xs text-slate-500 mt-0.5">{worksiteName} · <span className="capitalize">{formatDate(date)}</span></p>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Météo */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-2">Météo</label>
            <div className="flex gap-2 flex-wrap">
              {WEATHER_OPTIONS.map(w => (
                <button
                  key={w.value}
                  type="button"
                  onClick={() => setWeather(w.value)}
                  className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg border text-xs transition-colors ${
                    weather === w.value
                      ? "border-[#0f3460] bg-[#0f3460]/5 text-[#0f3460] font-medium"
                      : "border-slate-200 text-slate-600 hover:border-slate-300"
                  }`}
                >
                  <span className="text-xl">{w.emoji}</span>
                  <span>{w.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Heures travaillées */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Heures travaillées</label>
            <input
              type="number"
              min={0}
              max={24}
              step={0.5}
              value={hoursWorked}
              onChange={e => setHoursWorked(parseFloat(e.target.value) || 0)}
              className="w-24 px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
            />
          </div>

          {/* Travaux effectués */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Travaux effectués <span className="text-red-400">*</span>
            </label>
            <textarea
              required
              rows={4}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Décrivez les travaux réalisés aujourd'hui..."
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20 resize-none"
            />
          </div>

          {/* Problèmes */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Problèmes rencontrés <span className="text-slate-400">(optionnel)</span>
            </label>
            <textarea
              rows={3}
              value={issues}
              onChange={e => setIssues(e.target.value)}
              placeholder="Incidents, retards, manque de matériaux..."
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20 resize-none"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Annuler
            </Button>
            <Button
              type="submit"
              className="flex-1 bg-[#0f3460] hover:bg-[#0a2540]"
              disabled={isPending}
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enregistrer"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
