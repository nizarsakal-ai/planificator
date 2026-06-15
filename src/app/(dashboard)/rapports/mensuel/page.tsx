import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users, Download, Calendar } from "lucide-react"
import { MonthPicker } from "@/components/rapports/MonthPicker"

export const metadata: Metadata = { title: "Rapport mensuel" }

const MONTH_NAMES = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]

function fmt(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(date)
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

  // Toutes les affectations employés du mois
  const rows = await prisma.employeeAssignment.findMany({
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
          date: true,
          worksite: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { assignment: { date: "asc" } },
  })

  // Grouper par employé → par chantier
  type ChantierSummary = { id: string; name: string; days: number; dates: string[] }
  type EmployeeSummary = {
    id: string
    firstName: string
    lastName: string
    totalDays: number
    chantiers: ChantierSummary[]
  }

  const byEmployee: Record<string, EmployeeSummary> = {}

  for (const row of rows) {
    const emp = row.employee
    const ws  = row.assignment.worksite
    const dateStr = fmt(row.assignment.date)

    if (!byEmployee[emp.id]) {
      byEmployee[emp.id] = {
        id: emp.id,
        firstName: emp.firstName,
        lastName: emp.lastName,
        totalDays: 0,
        chantiers: [],
      }
    }

    const empSummary = byEmployee[emp.id]
    empSummary.totalDays++

    let ch = empSummary.chantiers.find((c) => c.id === ws.id)
    if (!ch) {
      ch = { id: ws.id, name: ws.name, days: 0, dates: [] }
      empSummary.chantiers.push(ch)
    }
    ch.days++
    if (!ch.dates.includes(dateStr)) ch.dates.push(dateStr)
  }

  const employees = Object.values(byEmployee).sort((a, b) =>
    a.lastName.localeCompare(b.lastName)
  )

  const totalJours = employees.reduce((s, e) => s + e.totalDays, 0)

  const currentMois = `${year}-${String(month).padStart(2, "0")}`
  const pdfUrl = `/api/pdf/paie?mois=${currentMois}`

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Rapport mensuel de paie</h1>
          <p className="text-sm text-slate-500 mt-1">Jours travaillés par ouvrier — {monthLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <MonthPicker value={currentMois} />
          <a
            href={pdfUrl}
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
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
              <Users className="h-5 w-5 text-slate-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{employees.length}</p>
              <p className="text-xs text-slate-500">Ouvriers actifs</p>
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
              <p className="text-xs text-slate-500">Jours-homme total</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tableau par employé */}
      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-slate-400 text-sm">
            Aucune affectation enregistrée pour {monthLabel}.
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
                  <span className="inline-flex items-center gap-1 bg-[#0f3460]/10 text-[#0f3460] text-xs font-bold px-2.5 py-1 rounded-full">
                    {emp.totalDays} jour{emp.totalDays > 1 ? "s" : ""}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="space-y-1.5">
                  {emp.chantiers.map((ch) => (
                    <div key={ch.id} className="flex items-center justify-between text-xs py-1 border-b border-slate-50 last:border-0">
                      <span className="text-slate-700 font-medium truncate pr-4">{ch.name}</span>
                      <span className="text-slate-500 shrink-0">{ch.days}j</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
