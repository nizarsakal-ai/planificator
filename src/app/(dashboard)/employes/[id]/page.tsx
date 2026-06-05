import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import Link from "next/link"
import { ArrowLeft, Mail, Phone, Calendar, Users } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getInitials } from "@/lib/utils"
import { AvatarUpload } from "@/components/employes/AvatarUpload"
import { EmployeActions } from "@/components/employes/EmployeActions"
import { EmployeeProfileTabs } from "@/components/employes/EmployeeProfileTabs"

export const metadata: Metadata = { title: "Profil employé" }

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé", SICK: "Maladie", UNPAID: "Congé sans solde",
  TRAINING: "Formation", OTHER: "Autre",
}
const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-700", APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
}
function fmt(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(d)
}

export default async function EmployeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const isAdmin      = ["ADMIN", "SUPER_ADMIN"].includes(session.user.role)
  const isTeamLeader = session.user.role === "TEAM_LEADER"
  if (!isAdmin && !isTeamLeader) redirect("/dashboard")

  const { id } = await params

  // Pour TEAM_LEADER : vérifier que l'employé est dans son équipe
  if (isTeamLeader) {
    const leaderEmployee = await prisma.employee.findFirst({
      where: { userId: session.user.id!, companyId: session.user.companyId! },
      select: {
        ledTeams: {
          where: { active: true },
          select: { members: { where: { leftAt: null }, select: { employeeId: true } } },
          take: 1,
        },
      },
    })
    const memberIds = leaderEmployee?.ledTeams[0]?.members.map((m) => m.employeeId) ?? []
    if (!memberIds.includes(id)) redirect("/dashboard")
  }

  const yearStart  = new Date(new Date().getFullYear(), 0, 1)
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)

  const employee = await prisma.employee.findFirst({
    where: { id, companyId: session.user.companyId! },
    include: {
      user: { select: { email: true, active: true } },
      teamMemberships: {
        where: { leftAt: null },
        include: { team: { select: { name: true, color: true } } },
      },
      absences: {
        where: { startDate: { gte: yearStart } },
        orderBy: { startDate: "desc" },
        take: 5,
      },
      employeeAssignments: {
        where: { date: { gte: monthStart } },
        include: { assignment: { include: { worksite: { select: { name: true } } } } },
        orderBy: { date: "desc" },
        take: 5,
      },
      expenseReports: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  })

  if (!employee) notFound()

  const fullName      = `${employee.firstName} ${employee.lastName}`
  const team          = employee.teamMemberships[0]?.team
  const approvedDays  = employee.absences.filter(a => a.status === "APPROVED")
    .reduce((s, a) => s + Math.round((a.endDate.getTime() - a.startDate.getTime()) / 86_400_000) + 1, 0)

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <Link href="/employes" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
        <ArrowLeft className="h-4 w-4" /> Retour aux employés
      </Link>

      {/* Header */}
      <div className="flex items-start gap-5">
        {/* Avatar */}
        {isAdmin ? (
          <AvatarUpload
            employeeId={employee.id}
            avatarUrl={employee.avatarUrl}
            initials={getInitials(fullName)}
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-bold text-lg shrink-0">
            {employee.avatarUrl
              ? <img src={employee.avatarUrl} alt={fullName} className="w-16 h-16 rounded-full object-cover" />
              : getInitials(fullName)
            }
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-slate-900">{fullName}</h1>
            <Badge variant={employee.active ? "default" : "secondary"}>
              {employee.active ? "Actif" : "Inactif"}
            </Badge>
          </div>
          {employee.jobTitle && (
            <p className="text-slate-500 text-sm mt-0.5">{employee.jobTitle}</p>
          )}
          <div className="flex flex-wrap gap-4 mt-3">
            <a href={`mailto:${employee.user.email}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-[#0f3460] transition-colors">
              <Mail className="h-3.5 w-3.5" /> {employee.user.email}
            </a>
            {employee.phone && (
              <a href={`tel:${employee.phone}`} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-[#0f3460] transition-colors">
                <Phone className="h-3.5 w-3.5" /> {employee.phone}
              </a>
            )}
            {team && (
              <span className="flex items-center gap-1.5 text-xs text-slate-500">
                <Users className="h-3.5 w-3.5" />
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: team.color ?? "#0f3460" }}
                />
                {team.name}
              </span>
            )}
            {employee.hiredAt && (
              <span className="flex items-center gap-1.5 text-xs text-slate-500">
                <Calendar className="h-3.5 w-3.5" /> Depuis le {fmt(employee.hiredAt)}
              </span>
            )}
          </div>
          {isAdmin && (
            <div className="mt-3">
              <EmployeActions employeeId={employee.id} active={employee.active} />
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-slate-900">{employee.employeeAssignments.length}</p>
            <p className="text-xs text-slate-500 mt-0.5">Affectations ce mois</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-slate-900">{employee.absences.length}</p>
            <p className="text-xs text-slate-500 mt-0.5">Absences cette année</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-slate-900">{approvedDays}</p>
            <p className="text-xs text-slate-500 mt-0.5">Jours approuvés cette année</p>
          </CardContent>
        </Card>
      </div>

      <EmployeeProfileTabs
        employeeId={employee.id}
        defaultValues={{
          firstName: employee.firstName,
          lastName:  employee.lastName,
          email:     employee.user.email,
          jobTitle:  employee.jobTitle ?? "",
          phone:     employee.phone    ?? "",
          hiredAt:   employee.hiredAt  ? employee.hiredAt.toISOString().split("T")[0] : "",
        }}
        absences={employee.absences}
        assignments={employee.employeeAssignments}
        expenses={employee.expenseReports}
      />
    </div>
  )
}
