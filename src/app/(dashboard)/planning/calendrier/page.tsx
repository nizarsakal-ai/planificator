import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { CalendarView } from "@/components/planning/CalendarView"
import { resolveWorksiteViewer, worksiteAccessWhere } from "@/lib/chantiers/worksite-access"

export const metadata: Metadata = { title: "Calendrier" }

export default async function CalendrierPage({ searchParams }: { searchParams: Promise<{ month?: string; year?: string }> }) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const sp = await searchParams
  const now = new Date()
  const month = parseInt(sp.month ?? String(now.getMonth() + 1))
  const year  = parseInt(sp.year  ?? String(now.getFullYear()))

  const startOfMonth = new Date(year, month - 1, 1)
  const endOfMonth   = new Date(year, month, 0, 23, 59, 59)

  const assignments = await prisma.assignment.findMany({
    where: {
      worksite: { companyId: session.user.companyId! },
      date: { gte: startOfMonth, lte: endOfMonth },
    },
    include: {
      worksite: { select: { id: true, name: true } },
      team: { select: { id: true, name: true, color: true } },
    },
    orderBy: { date: "asc" },
  })
  // Lien vers la fiche seulement si elle s'ouvre pour cet utilisateur (même règle que la fiche chantier).
  const scope = worksiteAccessWhere(await resolveWorksiteViewer(prisma, session.user))
  const worksiteIds = [...new Set(assignments.map((a) => a.worksite.id))]
  const openable = !scope ? new Set<string>() : new Set((await prisma.worksite.findMany({
    where: { id: { in: worksiteIds }, companyId: session.user.companyId!, ...scope },
    select: { id: true },
  })).map((w) => w.id))
  const entries = assignments.map((a) => ({ ...a, canOpen: openable.has(a.worksite.id) }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Calendrier</h1>
        <p className="text-sm text-slate-500 mt-1">Vue mensuelle de toutes les affectations</p>
      </div>
      <CalendarView assignments={entries} month={month} year={year} />
    </div>
  )
}
