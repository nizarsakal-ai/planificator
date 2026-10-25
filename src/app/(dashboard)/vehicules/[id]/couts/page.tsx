import { VehicleWorkspaceNav } from "@/components/vehicules/v3/VehicleWorkspaceNav"
import { notFound } from "next/navigation"
import { expenseEnabled } from "@/lib/vehicules/v3/expense-domain"
import { VehicleCostsPanel } from "@/components/vehicules/v3/VehicleCostsPanel"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { requireMileageSession } from "@/lib/vehicules/mileage-access"
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
export default async function VehicleCostsPage({ params }: { params: Promise<{ id: string }> }) {
  if (!expenseEnabled()) notFound()
  const { id } = await params
  let timeZone:string
  try {
    const session=requireMileageSession(await auth())
    timeZone=await prisma.$transaction(async tx=>{await authorizeVehicleLocked(tx,id,session,"READING");return (await tx.companySettings.findUnique({where:{companyId:session.companyId}}))?.timezone||"Europe/Paris"},{maxWait:5000,timeout:15000})
  }catch(error){if(error instanceof MileageDomainError&&[401,403,404].includes(error.status))notFound();throw error}
  return <main className="p-4 space-y-4"><VehicleWorkspaceNav truckId={id} active="couts" /><h1 className="text-2xl font-bold">Dépenses et coûts du véhicule</h1><VehicleCostsPanel truckId={id} timeZone={timeZone} /></main>
}
