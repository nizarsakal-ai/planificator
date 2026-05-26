"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight, Users, HardHat } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

interface Assignment {
  id: string
  date: string
  status: string
  teamName: string
  worksiteName: string
  worksiteId: string
}

interface PlanningCalendarProps {
  assignments: Assignment[]
}

const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: "bg-green-100 border-green-300 text-green-800",
  PENDING:   "bg-blue-100 border-blue-300 text-blue-800",
  REFUSED:   "bg-red-100 border-red-300 text-red-500 line-through opacity-60",
}

function getMonday(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1 - day)
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function formatMonthYear(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(date)
}

function formatDayNum(date: Date): string {
  return String(date.getDate())
}

export function PlanningCalendar({ assignments }: PlanningCalendarProps) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()))

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  const prevWeek = () => setWeekStart(addDays(weekStart, -7))
  const nextWeek = () => setWeekStart(addDays(weekStart, 7))
  const today    = () => setWeekStart(getMonday(new Date()))

  const getAssignmentsForDay = (day: Date) =>
    assignments.filter((a) => isSameDay(new Date(a.date), day))

  const todayDate = new Date()

  return (
    <div className="space-y-4">
      {/* Contrôles navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={prevWeek}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={nextWeek}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={today}>
            Aujourd&apos;hui
          </Button>
        </div>
        <p className="text-sm font-semibold text-slate-700 capitalize">
          {formatMonthYear(weekStart)}
        </p>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-200 inline-block" /> Confirmé</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-200 inline-block" /> En attente</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-200 inline-block" /> Refusé</span>
        </div>
      </div>

      {/* Grille semaine */}
      <div className="grid grid-cols-7 gap-2">
        {weekDays.map((day, i) => {
          const dayAssignments = getAssignmentsForDay(day)
          const isToday = isSameDay(day, todayDate)
          const isWeekend = i >= 5

          return (
            <div
              key={day.toISOString()}
              className={`min-h-[140px] rounded-xl border p-2 flex flex-col gap-1.5 ${
                isToday
                  ? "border-[#0f3460] bg-blue-50"
                  : isWeekend
                  ? "border-slate-100 bg-slate-50"
                  : "border-slate-200 bg-white"
              }`}
            >
              {/* Header du jour */}
              <div className="text-center mb-1">
                <p className={`text-xs font-medium ${isWeekend ? "text-slate-400" : "text-slate-500"}`}>
                  {JOURS[i]}
                </p>
                <p className={`text-lg font-bold leading-tight ${
                  isToday ? "text-[#0f3460]" : isWeekend ? "text-slate-400" : "text-slate-800"
                }`}>
                  {formatDayNum(day)}
                </p>
              </div>

              {/* Affectations */}
              {dayAssignments.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-xs text-slate-200">—</span>
                </div>
              ) : (
                dayAssignments.map((a) => (
                  <div
                    key={a.id}
                    className={`rounded-lg border px-2 py-1.5 text-xs ${STATUS_COLORS[a.status] ?? "bg-slate-100 border-slate-200 text-slate-700"}`}
                  >
                    <div className="flex items-center gap-1 font-semibold truncate">
                      <Users className="h-3 w-3 shrink-0" />
                      <span className="truncate">{a.teamName}</span>
                    </div>
                    <div className="flex items-center gap-1 text-slate-500 truncate mt-0.5">
                      <HardHat className="h-3 w-3 shrink-0" />
                      <span className="truncate">{a.worksiteName}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )
        })}
      </div>

      {/* Légende total semaine */}
      <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
        <span>
          {weekDays.reduce((acc, d) => acc + getAssignmentsForDay(d).length, 0)} affectation(s) cette semaine
        </span>
        <span>
          {new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(weekStart)}
          {" → "}
          {new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(addDays(weekStart, 6))}
        </span>
      </div>
    </div>
  )
}
