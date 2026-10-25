import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMileageCommand } from "@/lib/vehicules/mileage-api"
import type { MileageServiceDeps } from "@/lib/vehicules/mileage-service"

// Arrivée. Le tripId vient uniquement du chemin.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; tripId: string }> },
  deps: MileageServiceDeps = { auth, db: prisma },
) {
  const { id, tripId } = await context.params
  return handleMileageCommand(request, { truckId: id, action: "END", targetId: tripId }, deps)
}
