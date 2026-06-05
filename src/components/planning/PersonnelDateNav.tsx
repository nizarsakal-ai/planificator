"use client"

import { useRouter } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"

export function PersonnelDateNav({ currentDate }: { currentDate: string }) {
  const router = useRouter()

  function navigate(offsetDays: number) {
    const d = new Date(currentDate + "T00:00:00")
    d.setDate(d.getDate() + offsetDays)
    router.push(`/planning/personnel?date=${d.toISOString().split("T")[0]}`)
  }

  const label = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(currentDate + "T00:00:00"))

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => navigate(-1)}
        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
        title="Jour précédent"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <input
        type="date"
        value={currentDate}
        onChange={(e) =>
          e.target.value && router.push(`/planning/personnel?date=${e.target.value}`)
        }
        className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700 cursor-pointer capitalize"
      />
      <button
        onClick={() => navigate(1)}
        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
        title="Jour suivant"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  )
}
