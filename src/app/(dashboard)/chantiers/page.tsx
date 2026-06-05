import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { HardHat } from "lucide-react"
import { NouveauChantierDialog } from "@/components/chantiers/NouveauChantierDialog"
import { ChantiersView } from "@/components/chantiers/ChantiersView"

export const metadata: Metadata = { title: "Chantiers" }

export default async function ChantiersPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const isAdmin      = ["ADMIN", "SUPER_ADMIN"].includes(session.user.role)
  const isTeamLeader = session.user.role === "TEAM_LEADER"
  if (!isAdmin && !isTeamLeader) redirect("/dashboard")

  const companyId = session.user.companyId!

  // Pour TEAM_LEADER : récupérer son équipe et filtrer les chantiers
  let teamId: string | undefined
  if (isTeamLeader) {
    const leaderEmployee = await prisma.employee.findFirst({
      where: { userId: session.user.id!, companyId },
      select: { ledTeams: { where: { active: true }, select: { id: true }, take: 1 } },
    })
    teamId = leaderEmployee?.ledTeams[0]?.id
    if (!teamId) redirect("/dashboard")
  }

  const worksiteWhere = isTeamLeader
    ? { companyId, assignments: { some: { teamId } } }
    : { companyId }

  const [chantiers, clients] = await Promise.all([
    prisma.worksite.findMany({
      where: worksiteWhere,
      include: {
        client: { select: { name: true } },
        _count: { select: { assignments: true } },
        assignments: {
          select: {
            teamId: true,
            team: {
              select: {
                id: true,
                name: true,
                color: true,
                leader: { select: { firstName: true, lastName: true } },
              },
            },
          },
          orderBy: { date: "desc" },
          take: 30,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    isAdmin
      ? prisma.client.findMany({
          where: { companyId, active: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ])

  const enCours   = chantiers.filter((c) => c.status === "IN_PROGRESS").length
  const planifies = chantiers.filter((c) => c.status === "PLANNED").length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {isTeamLeader ? "Mes chantiers" : "Chantiers"}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {enCours} en cours · {planifies} planifié{planifies > 1 ? "s" : ""}
          </p>
        </div>
        {isAdmin && <NouveauChantierDialog clients={clients} />}
      </div>

      {chantiers.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <HardHat className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun chantier pour le moment.</p>
            {isAdmin && (
              <p className="text-slate-400 text-sm mt-1">
                Cliquez sur &quot;Nouveau chantier&quot; pour commencer.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <ChantiersView chantiers={chantiers} />
      )}
    </div>
  )
}
