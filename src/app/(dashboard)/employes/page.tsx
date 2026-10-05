import type { Metadata } from "next"
import Image from "next/image"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Users } from "lucide-react"
import { NouvelEmployeDialog } from "@/components/employes/NouvelEmployeDialog"
import { InviterMembreDialog } from "@/components/invitations/InviterMembreDialog"
import { EmployesView } from "@/components/employes/EmployesView"
import { EmployeStats } from "@/components/employes/EmployeStats"
import { ResendAccessButton } from "@/components/employes/ResendAccessButton"
import { computeEmployeeStats, toEmployeeViewItems } from "@/lib/employes/employes-view"

export const metadata: Metadata = { title: "Employés" }

export default async function EmployesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const companyId = session.user.companyId!

  const rows = await prisma.employee.findMany({
    where: { companyId },
    select: {
      id: true,
      companyId: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      phone: true,
      avatarUrl: true,
      active: true,
      user: { select: { role: true } },
      teamMemberships: {
        where: { leftAt: null, team: { companyId } },
        select: { team: { select: { id: true, name: true, color: true, companyId: true } } },
      },
      ledTeams: {
        where: { active: true, companyId },
        select: { id: true, name: true, color: true, companyId: true },
      },
    },
    orderBy: { firstName: "asc" },
  })

  const employees = toEmployeeViewItems(rows, companyId)
  const stats = computeEmployeeStats(employees)

  return (
    <div className="space-y-6">
      {/* Bandeau — image décorative ; le texte reste du vrai HTML */}
      <section className="relative isolate h-28 overflow-hidden rounded-xl bg-[#0f3460] sm:h-32 lg:h-36">
        <div aria-hidden="true" className="absolute inset-0 -z-10">
          <Image
            src="/images/employees/employees-hero.jpg"
            alt=""
            fill
            priority
            sizes="(min-width: 768px) calc(100vw - 16rem), 100vw"
            className="object-cover object-[78%_35%]"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#0f3460]/95 via-[#0f3460]/75 to-[#0f3460]/10 sm:via-[#0f3460]/60 sm:to-transparent" />
        </div>
        <div className="flex h-full max-w-xl flex-col justify-center px-5 sm:px-8">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Employés</h1>
          <p className="mt-1 text-sm text-white/85">
            Vos équipes, au service de vos chantiers
          </p>
        </div>
      </section>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-end">
        <div className="flex flex-wrap items-center gap-2">
          <ResendAccessButton />
          <InviterMembreDialog
            canInviteAdmin={["ADMIN", "SUPER_ADMIN"].includes(session.user.role)}
          />
          <NouvelEmployeDialog />
        </div>
      </div>

      <EmployeStats stats={stats} />

      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun employé pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Créer un employé&quot; pour commencer.</p>
          </CardContent>
        </Card>
      ) : (
        <EmployesView employees={employees} />
      )}
    </div>
  )
}
