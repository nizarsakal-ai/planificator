"use client"

import { useRouter } from "next/navigation"
import Link from "next/link"
import { ChevronLeft, ChevronRight } from "lucide-react"

interface Assignment {
  id: string
  date: Date
  status: string
  worksite: { id: string; name: string }
  team: { id: string; name: string; color: string | null }
}

interface CalendarViewProps {
  assignments: Assignment[]
  month: number
  year: number
}

const STATUS_OPACITY: Record<string, string> = {
  CONFIRMED: "opacity-100",
  PENDING:   "opacity-60",
  REFUSED:   "opacity-30",
}

const MONTH_NAMES = [
  "Janvier","Février","Mars","Avril","Mai","Juin",
  "Juillet","Août","Septembre","Octobre","Novembre","Décembre"
]
const DAY_NAMES = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"]

export function CalendarView({ assignments, month, year }: CalendarViewProps) {
  const router = useRouter()

  function navigate(delta: number) {
    let m = month + delta
    let y = year
    if (m > 12) { m = 1; y++ }
    if (m < 1)  { m = 12; y-- }
    router.push(`/planning/calendrier?month=${m}&year=${y}`)
  }

  const today = new Date()
  const firstDay = new Date(year, month - 1, 1)
  // Monday-based: getDay() returns 0=Sun, shift to Mon=0
  const startDow = (firstDay.getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()

  // Build grid: rows × 7 cols
  const cells: (number | null)[] = [
    ...Array(startDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  // Group assignments by day number
  const byDay: Record<number, Assignment[]> = {}
  for (const a of assignments) {
    const d = new Date(a.date)
    const day = d.getUTCDate()
    if (!byDay[day]) byDay[day] = []
    byDay[day].push(a)
  }

  const isToday = (day: number) =>
    today.getDate() === day &&
    today.getMonth() + 1 === month &&
    today.getFullYear() === year

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Header navigation */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ChevronLeft className="h-4 w-4 text-slate-600" />
        </button>
        <h2 className="text-base font-semibold text-slate-900">
          {MONTH_NAMES[month - 1]} {year}
        </h2>
        <button
          onClick={() => navigate(1)}
          className="p-2 rounded-lg hover:bg-slate-100 transition-colors"
        >
          <ChevronRight className="h-4 w-4 text-slate-600" />
        </button>
      </div>

      {/* Day names header */}
      <div className="grid grid-cols-7 border-b border-slate-100">
        {DAY_NAMES.map(d => (
          <div key={d} className="py-2 text-center text-xs font-medium text-slate-400">
            {d}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {cells.map((day, i) => (
          <div
            key={i}
            className={`min-h-[90px] p-1.5 border-b border-r border-slate-100 ${
              !day ? "bg-slate-50/50" : ""
            } ${i % 7 === 6 ? "border-r-0" : ""}`}
          >
            {day && (
              <>
                <div className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-medium mb-1 ${
                  isToday(day)
                    ? "bg-[#0f3460] text-white"
                    : "text-slate-600"
                }`}>
                  {day}
                </div>
                <div className="space-y-0.5">
                  {(byDay[day] ?? []).slice(0, 3).map(a => (
                    <Link
                      key={a.id}
                      href={`/chantiers/${a.worksite.id}`}
                      className={`block truncate text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_OPACITY[a.status] ?? "opacity-100"} hover:opacity-80 transition-opacity`}
                      style={{
                        backgroundColor: (a.team.color ?? "#0f3460") + "25",
                        color: a.team.color ?? "#0f3460",
                        borderLeft: `2px solid ${a.team.color ?? "#0f3460"}`,
                      }}
                      title={`${a.team.name} — ${a.worksite.name}`}
                    >
                      {a.team.name}
                    </Link>
                  ))}
                  {(byDay[day]?.length ?? 0) > 3 && (
                    <p className="text-[9px] text-slate-400 pl-1">+{byDay[day].length - 3} autres</p>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="px-5 py-3 border-t border-slate-100 flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-200 border-l-2 border-slate-400" />Confirmé</span>
        <span className="flex items-center gap-1.5 opacity-60"><span className="w-3 h-3 rounded-sm bg-slate-200 border-l-2 border-slate-400" />En attente</span>
        <span className="flex items-center gap-1.5 opacity-30"><span className="w-3 h-3 rounded-sm bg-slate-200 border-l-2 border-slate-400" />Refusé</span>
      </div>
    </div>
  )
}
