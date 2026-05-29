import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect, notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import Link from "next/link"
import { ArrowLeft, Crown, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { getInitials } from "@/lib/utils"
import { EquipeEditForm } from "@/components/equipes/EquipeEditForm"
import { MembreActions } from "@/components/equipes/MembreActions"
import { AjouterMembreDialog } from "@/components/equipes/AjouterMembreDialog"
import { EquipeArchiveButton } from "@/components/equipes/EquipeArchiveButton"

export const metadata: Metadata = { title: "Détail équipe" }

export default async function EquipeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const { id } = await params

  const [team, allEmployees] = await Promise.all([
    prisma.team.findFirst({
      where: { id, companyId: session.user.companyId! },
      include: {
        leader: true,
        members: {
          where: { leftAt: null },
          include: { employee: true },
          orderBy: { joinedAt: "asc" },
        },
      },
    }),
    prisma.employee.findMany({
      where: { companyId: session.user.companyId!, active: true },
      orderBy: { firstName: "asc" },
      select: { id: true, firstName: true, lastName: true, jobTitle: true },
    }),
  ])

  if (!team) notFound()

  const memberIds = team.members.map((m) => m.employeeId)
  const available = allEmployees.filter((e) => !memberIds.includes(e.id))

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <Link
        href="/equipes"
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" /> Retour aux équipes
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0"
            style={{ backgroundColor: team.color ?? "#0f3460" }}
          >
            {team.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900">{team.name}</h1>
              <Badge variant={team.active ? "default" : "secondary"}>
                {team.active ? "Active" : "Archivée"}
              </Badge>
            </div>
            <p className="text-sm text-slate-500 flex items-center gap-1 mt-0.5">
              <Users className="h-3.5 w-3.5" />
              {team.members.length} membre{team.members.length > 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <EquipeArchiveButton teamId={team.id} active={team.active} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Modifier l'équipe */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Modifier l'équipe</CardTitle>
          </CardHeader>
          <CardContent>
            <EquipeEditForm
              teamId={team.id}
              defaultValues={{
                name:     team.name,
                color:    team.color ?? "#0f3460",
                leaderId: team.leaderId,
              }}
              employees={allEmployees}
            />
          </CardContent>
        </Card>

        {/* Membres */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Membres</CardTitle>
              <AjouterMembreDialog teamId={team.id} available={available} />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {/* Chef d'équipe */}
            <div className="flex items-center gap-2 mx-4 mb-3 p-2.5 bg-amber-50 rounded-lg">
              <Crown className="h-4 w-4 text-amber-500 shrink-0" />
              <div>
                <p className="text-xs text-amber-700 font-medium">Chef d'équipe</p>
                <p className="text-sm font-semibold text-slate-800">
                  {team.leader.firstName} {team.leader.lastName}
                </p>
              </div>
            </div>

            {team.members.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-6 px-4">
                Aucun membre dans cette équipe.
              </p>
            ) : (
              <div className="divide-y divide-slate-50">
                {team.members.map((membre) => {
                  const isLeader = membre.employeeId === team.leaderId
                  const name = `${membre.employee.firstName} ${membre.employee.lastName}`

                  return (
                    <div
                      key={membre.id}
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-50"
                    >
                      <div className="flex items-center gap-2.5">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback
                            className="text-white text-xs font-medium"
                            style={{ backgroundColor: team.color ?? "#0f3460" }}
                          >
                            {getInitials(name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="text-sm font-medium text-slate-800">{name}</p>
                          {membre.employee.jobTitle && (
                            <p className="text-xs text-slate-400">{membre.employee.jobTitle}</p>
                          )}
                        </div>
                      </div>
                      <MembreActions
                        teamId={team.id}
                        employeeId={membre.employeeId}
                        isLeader={isLeader}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
