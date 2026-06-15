import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users, Download, Calendar, AlertCircle } from "lucide-react"
import { MonthPicker } from "@/components/rapports/MonthPicker"

export const metadata: Metadata = { title: "Rapport mensuel" }

const MONTH_NAMES = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]

const ABSENCE_LABELS: Record<string, string> = {
  VACATION: "Congés payés",
  SICK:     "Arrêt maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre absence",
}

function daysInMonth(start: Date, end: Date, monthStart: Date, monthEnd: Date): number {
  const from = start > monthStart ? start : monthStart
  const to   = end   < monthEnd   ? end   : monthEnd
  if (from > to) return 0
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1
}

export default async function RapportMensuelPage({
  searchParams,
}: {
  searchParams: Promise<{ mois?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/rapports")

  const sp = await searchParams
  const now = new Date()
  const [yearStr, monthStr] = (sp.mois ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`).split("-")
  const year  = parseInt(yearStr)
  const month = parseInt(monthStr)

  const startOfMonth = new Date(year, month - 1, 1)
  const endOfMonth   = new Date(year, month, 0, 23, 59, 59)
  const companyId    = session.user.companyId!
  const monthLabel   = `${MONTH_NAMES[month - 1]} ${year}`

  const [rows, absences] = await Promise.all([
    // Affectations du mois
    prisma.employeeAssignment.findMany({
      where: {
        assignment: {
          worksite: { companyId },
          date: { gte: startOfMonth, lte: endOfMonth },
        },
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
        assignment: {
          select: {
            worksite: { select: { id: true, name: true } },
          },
        },
      },
    }),
    // Absences approuvées chevauchant le mois
    prisma.absence.findMany({
      where: {
        companyId,
        status: "APPROVED",
        startDate: { lte: new Date(year, month, 0) },
        endDate:   { gte: new Date(year, month - 1, 1) },
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
  ])

  type AbsenceSummary = { type: string; days: number }
  type ChantierSummary = { id: string; name: string; days: number }
  type EmployeeSummary = {
    id: string; firstName: string; lastName: string
    totalDays: number; absenceDays: number
    chantiers: ChantierSummary[]; absences: AbsenceSummary[]
  }

  const byEmployee: Record<string, EmployeeSummary> = {}

  function getOrCreate(emp: { id: string; firstName: string; lastName: string }) {
    if (!byEmployee[emp.id]) {
      byEmployee[emp.id] = {
        id: emp.id, firstName: emp.firstName, lastName: emp.lastName,
        totalDays: 0, absenceDays: 0, chantiers: [], absences: [],
      }
    }
    return byEmployee[emp.id]
  }

  for (const row of rows) {
    const e = getOrCreate(row.employee)
    e.totalDays++
    let ch = e.chantiers.find((c) => c.id === row.assignment.worksite.id)
    if (!ch) { ch = { id: row.assignment.worksite.id, name: row.assignment.worksite.name, days: 0 }; e.chantiers.push(ch) }
    ch.days++
  }

  for (const abs of absences) {
    const e = getOrCreate(abs.employee)
    const days = daysInMonth(abs.startDate, abs.endDate, startOfMonth, endOfMonth)
    if (days <= 0) continue
    e.absenceDays += days
    const existing = e.absences.find((a) => a.type === abs.type)
    if (existing) existing.days += days
    else e.absences.push({ type: abs.type, days })
  }

  const employees = Object.values(byEmployee).sort((a, b) => a.lastName.localeCompare(b.lastName))
  const totalJours   = employees.reduce((s, e) => s + e.totalDays, 0)
  const totalAbsence = employees.reduce((s, e) => s + e.absenceDays, 0)
  const currentMois  = `${year}-${String(month).padStart(2, "0")}`

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rapport mensuel de paie</h1>
          <p className="text-sm text-slate-500 mt-1">Jours travaillés et absences — {monthLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <MonthPicker value={currentMois} />
          <a
            href={`/api/pdf/paie?mois=${currentMois}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-[#0f3460] text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-[#0f3460]/90 transition-colors"
          >
            <Download className="h-4 w-4" />
            Export PDF
          </a>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
              <Users className="h-5 w-5 text-slate-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{employees.length}</p>
              <p className="text-xs text-slate-500">Ouvriers</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <Calendar className="h-5 w-5 text-[#0f3460]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalJours}</p>
              <p className="text-xs text-slate-500">Jours travaillés</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
              <AlertCircle className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{totalAbsence}</p>
              <p className="text-xs text-slate-500">Jours d'absence</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tableau par employé */}
      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-slate-400 text-sm">
            Aucune donnée enregistrée pour {monthLabel}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {employees.map((emp) => (
            <Card key={emp.id}>
              <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-slate-800">
                    {emp.firstName} {emp.lastName}
                  </CardTitle>
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <span className="text-slate-500">{emp.totalDays}j</span>
                    {emp.absenceDays > 0 && (
                      <>
                        <span className="text-amber-600">− {emp.absenceDays}j</span>
                        <span className="text-slate-400">=</span>
                        <span className="bg-[#0f3460]/10 text-[#0f3460] px-2.5 py-1 rounded-full font-bold">
                          {emp.totalDays - emp.absenceDays}j net
                        </span>
                      </>
                    )}
                    {emp.absenceDays === 0 && (
                      <span className="bg-[#0f3460]/10 text-[#0f3460] px-2.5 py-1 rounded-full font-bold">
                        {emp.totalDays}j net
                      </span>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4 space-y-1">
                {emp.chantiers.map((ch) => (
                  <div key={ch.id} className="flex items-center justify-between text-xs py-1 border-b border-slate-50 last:border-0">
                    <span className="text-slate-700 font-medium truncate pr-4">{ch.name}</span>
                    <span className="text-slate-500 shrink-0">{ch.days}j</span>
                  </div>
                ))}
                {emp.absences.map((a) => (
                  <div key={a.type} className="flex items-center justify-between text-xs py-1 border-b border-amber-50 last:border-0">
                    <span className="text-amber-700 font-medium">{ABSENCE_LABELS[a.type] ?? a.type}</span>
                    <span className="text-amber-600 shrink-0 font-semibold">-{a.days}j</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
