import { VehicleWorkspaceNav } from "@/components/vehicules/v3/VehicleWorkspaceNav"
import { notFound } from "next/navigation"
import { expenseEnabled } from "@/lib/vehicules/v3/expense-domain"
import { VehicleCostsPanel } from "@/components/vehicules/v3/VehicleCostsPanel"
import { VehicleWorksiteCosts } from "@/components/vehicules/v3/VehicleWorksiteCosts"
import { isFuelEstimateEnabled } from "@/lib/vehicules/v3/fuel-estimate-domain"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { requireMileageSession } from "@/lib/vehicules/mileage-access"
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority"
import { MileageDomainError } from "@/lib/vehicules/mileage-domain"
export default async function VehicleCostsPage({ params }: { params: Promise<{ id: string }> }) {
  if (!expenseEnabled()) notFound()
  const { id } = await params
  let timeZone:string, companyId:string
  try {
    const session=requireMileageSession(await auth())
    companyId=session.companyId
    timeZone=await prisma.$transaction(async tx=>{await authorizeVehicleLocked(tx,id,session,"READING");return (await tx.companySettings.findUnique({where:{companyId:session.companyId}}))?.timezone||"Europe/Paris"},{maxWait:5000,timeout:15000})
  }catch(error){if(error instanceof MileageDomainError&&[401,403,404].includes(error.status))notFound();throw error}
  return <main className="p-4 space-y-4"><VehicleWorkspaceNav truckId={id} active="couts" /><h1 className="text-2xl font-bold">Carburant et coûts</h1><VehicleWorksiteCosts truckId={id} timeZone={timeZone} />
    <details className="rounded-2xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">Saisir une dépense et registre comptable</summary>
      <div className="mt-4 space-y-4"><VehicleCostsPanel truckId={id} companyId={companyId} timeZone={timeZone} fuelEstimateEnabled={isFuelEstimateEnabled()} /></div></details></main>
}
