import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { VehiculesView } from "@/components/vehicules/VehiculesView"

export const metadata: Metadata = { title: "Véhicules" }

export default async function VehiculesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const [trucks, teams, employees] = await Promise.all([
    prisma.truck.findMany({
      where: { companyId: session.user.companyId! },
      include: {
        team: { select: { id: true, name: true, color: true } },
        chauffeur: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { matricule: "asc" },
    }),
    prisma.team.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.employee.findMany({
      where: { companyId: session.user.companyId!, active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { firstName: "asc" },
    }),
  ])

  return (
    <VehiculesView
      trucks={trucks.map((t) => ({
        id: t.id,
        matricule: t.matricule,
        marque: t.marque,
        team: t.team,
        chauffeur: t.chauffeur,
      }))}
      teams={teams}
      employees={employees}
    />
  )
}
