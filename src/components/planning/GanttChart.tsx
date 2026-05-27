"use client"

import { useState, useRef } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

interface Assignment {
  id: string
  date: Date
  status: "PENDING" | "CONFIRMED" | "REFUSED"
  team: { name: string }
}

interface GanttWorksite {
  id: string
  name: string
  status: string
  startDate: Date
  endDate: Date
  address: string | null
  client: { name: string }
  assignments: Assignment[]
}

interface GanttChartProps {
  chantiers: GanttWorksite[]
}

const statusColors: Record<string, string> = {
  PLANNED:     "bg-blue-400",
  IN_PROGRESS: "bg-green-500",
  EXTENDED:    "bg-amber-400",
  COMPLETED:   "bg-slate-400",
  ARCHIVED:    "bg-slate-600",
}

const statusLabels: Record<string, string> = {
  PLANNED:     "Planifié",
  IN_PROGRESS: "En cours",
  EXTENDED:    "Prolongé",
  COMPLETED:   "Terminé",
  ARCHIVED:    "Archivé",
}

const assignmentColors: Record<string, string> = {
  CONFIRMED: "bg-green-500",
  PENDING:   "bg-blue-400",
  REFUSED:   "bg-red-400",
}

function addMonths(date: Date, months: number) {
  const d = new Date(date)
  d.setMonth(d.getMonth() + months)
  return d
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function daysBetween(a: Date, b: Date) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

const MONTHS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Aoû", "Sep", "Oct", "Nov", "Déc"]
const DAYS_FR   = ["L", "M", "M", "J", "V", "S", "D"]

export function GanttChart({ chantiers }: GanttChartProps) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [viewStart, setViewStart] = useState(() => {
    const d = new Date(today)
    d.setDate(1)
    return d
  })

  const [tooltip, setTooltip] = useState<{
    x: number; y: number
    chantier: GanttWorksite
    assignment?: Assignment
  } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  // 3 mois affichés
  const viewEnd = addMonths(viewStart, 3)
  viewEnd.setDate(0) // dernier jour du mois précédent

  // Génère tous les jours de la période
  const days: Date[] = []
  const cur = new Date(viewStart)
  while (cur <= viewEnd) {
    days.push(new Date(cur))
    cur.setDate(cur.getDate() + 1)
  }

  const totalDays = days.length
  const DAY_WIDTH = 32 // px par jour
  const ROW_HEIGHT = 48

  // Groupes de mois pour l'en-tête
  const months: { label: string; count: number }[] = []
  let mCur = new Date(viewStart)
  while (mCur <= viewEnd) {
    const daysInMonth = getDaysInMonth(mCur.getFullYear(), mCur.getMonth())
    const daysVisible = Math.min(
      daysInMonth - mCur.getDate() + 1,
      daysBetween(mCur, viewEnd) + 1
    )
    months.push({
      label: `${MONTHS_FR[mCur.getMonth()]} ${mCur.getFullYear()}`,
      count: daysVisible,
    })
    mCur = new Date(mCur.getFullYear(), mCur.getMonth() + 1, 1)
  }

  const prevMonth = () => setViewStart(addMonths(viewStart, -1))
  const nextMonth = () => setViewStart(addMonths(viewStart, 1))
  const goToToday = () => {
    const d = new Date(today)
    d.setDate(1)
    setViewStart(d)
  }

  function getBarStyle(chantier: GanttWorksite) {
    const start = new Date(chantier.startDate)
    start.setHours(0, 0, 0, 0)
    const end   = new Date(chantier.endDate)
    end.setHours(0, 0, 0, 0)

    const startOffset = daysBetween(viewStart, start)
    const endOffset   = daysBetween(viewStart, end)

    const clampedStart = Math.max(0, startOffset)
    const clampedEnd   = Math.min(totalDays - 1, endOffset)

    if (clampedEnd < 0 || clampedStart >= totalDays) return null

    return {
      left:  clampedStart * DAY_WIDTH,
      width: Math.max(DAY_WIDTH, (clampedEnd - clampedStart + 1) * DAY_WIDTH),
    }
  }

  function getAssignmentStyle(date: Date) {
    const d = new Date(date)
    d.setHours(0, 0, 0, 0)
    const offset = daysBetween(viewStart, d)
    if (offset < 0 || offset >= totalDays) return null
    return { left: offset * DAY_WIDTH }
  }

  const todayOffset = daysBetween(viewStart, today)
  const showTodayLine = todayOffset >= 0 && todayOffset < totalDays

  return (
    <div className="space-y-4">
      {/* Contrôles */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <ChevronLeft className="h-4 w-4 text-slate-600" />
          </button>
          <button
            onClick={goToToday}
            className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            Aujourd&apos;hui
          </button>
          <button
            onClick={nextMonth}
            className="p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <ChevronRight className="h-4 w-4 text-slate-600" />
          </button>
          <span className="text-sm font-medium text-slate-700 ml-2">
            {MONTHS_FR[viewStart.getMonth()]} {viewStart.getFullYear()}
            {" → "}
            {MONTHS_FR[viewEnd.getMonth()]} {viewEnd.getFullYear()}
          </span>
        </div>

        {/* Légende */}
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-green-500" />Confirmé
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-blue-400" />En attente
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-red-400" />Refusé
          </div>
        </div>
      </div>

      {/* Tableau Gantt */}
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
        <div className="flex">
          {/* Colonne noms — fixe */}
          <div className="w-56 shrink-0 border-r border-slate-200 z-10">
            {/* En-tête vide */}
            <div className="h-16 border-b border-slate-200 bg-slate-50" />
            {/* Lignes */}
            {chantiers.map((c, i) => (
              <div
                key={c.id}
                className={`h-12 flex flex-col justify-center px-3 border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"}`}
              >
                <p className="text-xs font-semibold text-slate-800 truncate">{c.name}</p>
                <p className="text-[10px] text-slate-400 truncate">{c.client.name}</p>
              </div>
            ))}
          </div>

          {/* Zone scrollable */}
          <div className="flex-1 overflow-x-auto" ref={scrollRef}>
            <div style={{ width: totalDays * DAY_WIDTH, position: "relative" }}>

              {/* En-tête mois */}
              <div className="flex h-8 border-b border-slate-200 bg-slate-50">
                {months.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-center text-xs font-semibold text-slate-600 border-r border-slate-200"
                    style={{ width: m.count * DAY_WIDTH }}
                  >
                    {m.label}
                  </div>
                ))}
              </div>

              {/* En-tête jours */}
              <div className="flex h-8 border-b border-slate-200 bg-slate-50">
                {days.map((d, i) => {
                  const isToday = isSameDay(d, today)
                  const isWeekend = d.getDay() === 0 || d.getDay() === 6
                  return (
                    <div
                      key={i}
                      className={`flex flex-col items-center justify-center border-r border-slate-100 text-[10px] font-medium ${
                        isToday ? "bg-[#0f3460] text-white rounded" :
                        isWeekend ? "text-slate-300" : "text-slate-500"
                      }`}
                      style={{ width: DAY_WIDTH, minWidth: DAY_WIDTH }}
                    >
                      <span>{DAYS_FR[(d.getDay() + 6) % 7]}</span>
                      <span>{d.getDate()}</span>
                    </div>
                  )
                })}
              </div>

              {/* Lignes des chantiers */}
              {chantiers.map((chantier, i) => {
                const bar = getBarStyle(chantier)
                return (
                  <div
                    key={chantier.id}
                    className={`relative border-b border-slate-100 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"}`}
                    style={{ height: ROW_HEIGHT }}
                  >
                    {/* Colonnes week-end */}
                    {days.map((d, di) => (
                      (d.getDay() === 0 || d.getDay() === 6) && (
                        <div
                          key={di}
                          className="absolute top-0 bottom-0 bg-slate-50"
                          style={{ left: di * DAY_WIDTH, width: DAY_WIDTH }}
                        />
                      )
                    ))}

                    {/* Barre du chantier */}
                    {bar && (
                      <div
                        className={`absolute top-3 h-6 rounded-full opacity-30 ${statusColors[chantier.status] ?? "bg-slate-400"}`}
                        style={{ left: bar.left, width: bar.width }}
                        onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, chantier })}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-slate-700 px-2 truncate">
                          {chantier.name}
                        </span>
                      </div>
                    )}

                    {/* Points d'affectation */}
                    {chantier.assignments.map((a) => {
                      const style = getAssignmentStyle(a.date)
                      if (!style) return null
                      return (
                        <div
                          key={a.id}
                          className={`absolute top-2 w-5 h-8 rounded-sm opacity-80 ${assignmentColors[a.status]} cursor-pointer`}
                          style={{ left: style.left + DAY_WIDTH / 2 - 10 }}
                          onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, chantier, assignment: a })}
                          onMouseLeave={() => setTooltip(null)}
                        />
                      )
                    })}
                  </div>
                )
              })}

              {/* Ligne "aujourd'hui" */}
              {showTodayLine && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-red-400 z-20 pointer-events-none"
                  style={{ left: todayOffset * DAY_WIDTH + DAY_WIDTH / 2 }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs pointer-events-none"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          <p className="font-semibold text-slate-800">{tooltip.chantier.name}</p>
          <p className="text-slate-500">{tooltip.chantier.client.name}</p>
          {tooltip.assignment ? (
            <>
              <p className="text-slate-600 mt-1">
                Équipe : <strong>{tooltip.assignment.team.name}</strong>
              </p>
              <p className="text-slate-500">
                {new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(tooltip.assignment.date)}
                {" · "}
                <span className={
                  tooltip.assignment.status === "CONFIRMED" ? "text-green-600" :
                  tooltip.assignment.status === "REFUSED" ? "text-red-500" : "text-blue-500"
                }>
                  {tooltip.assignment.status === "CONFIRMED" ? "Confirmé" :
                   tooltip.assignment.status === "REFUSED" ? "Refusé" : "En attente"}
                </span>
              </p>
            </>
          ) : (
            <>
              <p className="text-slate-500 mt-1">
                {new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(tooltip.chantier.startDate)}
                {" → "}
                {new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(tooltip.chantier.endDate)}
              </p>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-white text-[10px] ${statusColors[tooltip.chantier.status]}`}>
                {statusLabels[tooltip.chantier.status]}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
