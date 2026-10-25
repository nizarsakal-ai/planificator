import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { VehicleSheet } from "@/components/vehicules/v3/VehicleSheet"
import { requireMileageSession } from "@/lib/vehicules/mileage-access"
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"

export const metadata: Metadata = { title: "Fiche véhicule" }

/**
 * Fiche camion (V3) : autorité effective sous verrou, dont chef affecté en lecture.
 * Le camion est lu dans le tenant explicite de la session uniquement.
 * Tant que le prototype n'est pas activé, la page n'existe pas (404).
 */
export default async function VehicleSheetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ onglet?: string }> }) {
  if (!isVehiclesV3Enabled()) notFound()
  const session = await auth()
  const { id } = await params
  let detail
  try {
    const scope = requireMileageSession(session)
    detail = await prisma.$transaction(async tx => {
      const { truck, actor, team } = await authorizeVehicleLocked(tx, id, scope, "READ")
      const chauffeur = truck.chauffeurId ? await tx.employee.findFirst({
        where: { id: truck.chauffeurId, companyId: scope.companyId },
        select: { firstName: true, lastName: true },
      }) : null
      return { truck, actor, team, chauffeur }
    }, {maxWait:5000,timeout:15000})
  } catch (error) {
    if (error instanceof MileageDomainError && [401, 403, 404].includes(error.status)) notFound()
    throw error
  }
  const { truck, actor, team, chauffeur } = detail
  const { onglet } = await searchParams
  return <VehicleSheet
    canManage={actor.role === "ADMIN" || actor.role === "SUPER_ADMIN"}
    initialTab={onglet ?? null}
    truck={{
      id: truck.id, matricule: truck.matricule, marque: truck.marque, modele: truck.modele, active: truck.active,
      archivedAt: truck.archivedAt?.toISOString() ?? null, teamName: team?.name ?? null,
      chauffeurName: chauffeur ? `${chauffeur.firstName} ${chauffeur.lastName}` : null,
    }} />
}
