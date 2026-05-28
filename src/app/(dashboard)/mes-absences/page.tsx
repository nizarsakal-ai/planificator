import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CalendarOff } from "lucide-react"
import { DemanderAbsenceDialog } from "@/components/absences/DemanderAbsenceDialog"

export const metadata: Metadata = { title: "Mes absences" }

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé",
  SICK:     "Maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre",
}

const STATUS_STYLE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  PENDING:  { label: "En attente", variant: "secondary" },
  APPROVED: { label: "Approuvé",   variant: "default" },
  REJECTED: { label: "Refusé",     variant: "destructive" },
}

function formatDate(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(d)
}
function diffDays(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
}

export default async function MesAbsencesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  // ADMIN → redirect vers la vue complète
  if (["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/absences")

  const employee = await prisma.employee.findUnique({
    where: { userId: session.user.id },
  })
  if (!employee) redirect("/dashboard")

  const absences = await prisma.absence.findMany({
    where: { employeeId: employee.id },
    orderBy: { startDate: "desc" },
  })

  const pending  = absences.filter((a) => a.status === "PENDING").length
  const approved = absences.filter((a) => a.status === "APPROVED").length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Mes absences</h1>
          <p className="text-sm text-slate-500 mt-1">
            {pending} en attente · {approved} approuvée{approved > 1 ? "s" : ""}
          </p>
        </div>
        <DemanderAbsenceDialog />
      </div>

      {absences.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <CalendarOff className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucune absence enregistrée.</p>
            <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Demander une absence&quot; pour soumettre une demande.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-50">
              {absences.map((absence) => {
                const st   = STATUS_STYLE[absence.status] ?? { label: absence.status, variant: "secondary" as const }
                const days = diffDays(absence.startDate, absence.endDate)
                return (
                  <div key={absence.id} className="px-5 py-3.5 hover:bg-slate-50 transition-colors">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">
                          {TYPE_LABELS[absence.type] ?? absence.type}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {formatDate(absence.startDate)} → {formatDate(absence.endDate)}{" "}
                          <span className="text-slate-400">({days}j)</span>
                        </p>
                        {absence.reason && (
                          <p className="text-xs text-slate-400 mt-0.5 italic">{absence.reason}</p>
                        )}
                      </div>
                      <Badge variant={st.variant} className="text-xs shrink-0">{st.label}</Badge>
                    </div>
                    {absence.refusalNote && (
                      <div className="mt-2 bg-red-50 border-l-2 border-red-300 rounded px-3 py-2">
                        <p className="text-xs text-red-700">
                          <span className="font-semibold">Motif du refus : </span>
                          {absence.refusalNote}
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
