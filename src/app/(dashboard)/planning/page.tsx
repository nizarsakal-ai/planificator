import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { PlanningCalendar } from "@/components/planning/PlanningCalendar"

export const metadata: Metadata = { title: "Planning" }

export default async function PlanningPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  // Récupérer les 3 mois de données (passé + futur)
  const from = new Date()
  from.setMonth(from.getMonth() - 1)
  from.setDate(1)

  const to = new Date()
  to.setMonth(to.getMonth() + 2)
  to.setDate(0)

  const assignments = await prisma.assignment.findMany({
    where: {
      worksite: { companyId: session.user.companyId! },
      date: { gte: from, lte: to },
    },
    include: {
      team:     { select: { name: true } },
      worksite: { select: { name: true, id: true } },
    },
    orderBy: { date: "asc" },
  })

  const data = assignments.map((a) => ({
    id:           a.id,
    date:         a.date.toISOString(),
    status:       a.status,
    teamName:     a.team.name,
    worksiteName: a.worksite.name,
    worksiteId:   a.worksite.id,
  }))

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Planning</h1>
        <p className="text-sm text-slate-500 mt-1">Vue hebdomadaire des affectations par équipe</p>
      </div>

      {/* Calendrier */}
      <Card>
        <CardContent className="p-6">
          <PlanningCalendar assignments={data} />
        </CardContent>
      </Card>
    </div>
  )
}
