import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { VehiculesView } from "@/components/vehicules/VehiculesView"
import { resolveVehiclesAccess, VEHICLE_HISTORY_LIMIT, limitHistory } from "@/lib/vehicules/vehicules-view"
import { maintenanceSummary } from "@/lib/vehicules/maintenance-domain"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"

export const metadata: Metadata = { title: "Véhicules" }

export default async function VehiculesPage() {
  const session = await auth()
  const access = resolveVehiclesAccess(session)
  if (access.kind === "redirect") redirect(access.to)
  const { companyId } = access

  const [trucks, teams, employees] = await Promise.all([
    prisma.truck.findMany({
      where: { companyId },
      include: {
        maintenancePlan: { select: { intervalKm: true, intervalMonths: true } },
        maintenanceEntries: {
          where: { kind: "OIL_CHANGE" },
          orderBy: [{ occurredAt: "desc" }, { mileage: "desc" }, { recordedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { kind: true, occurredAt: true, mileage: true, recordedAt: true },
        },
        team: { select: { id: true, name: true, color: true } },
        chauffeur: { select: { id: true, firstName: true, lastName: true } },
        assignments: {
          orderBy: { startedAt: "desc" },
          // LIMIT + 1 : la période en trop prouve qu'il en existe de plus anciennes (indication de troncature fiable).
          take: VEHICLE_HISTORY_LIMIT + 1,
          include: {
            chauffeur: { select: { firstName: true, lastName: true } },
            team: { select: { name: true } },
          },
        },
      },
      orderBy: { matricule: "asc" },
    }),
    prisma.team.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.employee.findMany({
      where: { companyId, active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { firstName: "asc" },
    }),
  ])

  return (
    <VehiculesView
      canManageV2={session?.user?.role === "ADMIN" || session?.user?.role === "SUPER_ADMIN"}
      v3Enabled={isVehiclesV3Enabled()}
      trucks={trucks.map((t) => {
        const { entries, truncated } = limitHistory(t.assignments)
        return {
          id: t.id,
          currentMileage: t.currentMileage,
          maintenanceSummary: maintenanceSummary(t.maintenancePlan, t.maintenanceEntries, t.currentMileage, new Date()),
          matricule: t.matricule,
          marque: t.marque,
          modele: t.modele,
          active: t.active,
          archivedAt: t.archivedAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
          team: t.team,
          chauffeur: t.chauffeur,
          history: entries.map((a) => ({
            id: a.id,
            chauffeurName: a.chauffeur ? `${a.chauffeur.firstName} ${a.chauffeur.lastName}` : null,
            teamName: a.team?.name ?? null,
            reason: a.reason,
            startedAt: a.startedAt.toISOString(),
            endedAt: a.endedAt?.toISOString() ?? null,
          })),
          historyTruncated: truncated,
        }
      })}
      teams={teams}
      employees={employees}
    />
  )
}
