import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { GanttChart } from "@/components/planning/GanttChart"

export const metadata: Metadata = { title: "Gantt" }

export default async function GanttPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const chantiers = await prisma.worksite.findMany({
    where: {
      companyId: session.user.companyId!,
      status: { notIn: ["ARCHIVED"] },
    },
    include: {
      client: { select: { name: true } },
      assignments: {
        include: { team: { select: { name: true } } },
        orderBy: { date: "asc" },
      },
    },
    orderBy: { startDate: "asc" },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Planning Gantt</h1>
        <p className="text-sm text-slate-500 mt-1">
          Vue temporelle de tous les chantiers et affectations
        </p>
      </div>

      {chantiers.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          Aucun chantier actif à afficher.
        </div>
      ) : (
        <GanttChart chantiers={chantiers} />
      )}
    </div>
  )
}
