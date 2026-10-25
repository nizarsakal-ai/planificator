import { notFound } from "next/navigation"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { VehicleImportsPanel } from "@/components/vehicules/v3/VehicleImportsPanel"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { preauthorizeImport } from "@/lib/vehicules/import-service"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
export default async function Page({params}:{params:Promise<{id:string}>}) {
  if (!isVehiclesV3Enabled()) notFound()
  const { id } = await params
  // Même autorité que l'API d'import : administrateur de l'entreprise effective du camion, relu sous verrou.
  try { await preauthorizeImport(id, { auth, db: prisma }) }
  catch (error) { if (error instanceof MileageDomainError && [401, 403, 404].includes(error.status)) notFound(); throw error }
  return <VehicleImportsPanel truckId={id} routingEnabled={process.env.PLANIFICATOR_ROUTING_ENABLED==="true"} />
}
