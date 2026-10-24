import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMileageCommand } from "@/lib/vehicules/mileage-api"
import type { MileageServiceDeps } from "@/lib/vehicules/mileage-service"

// Correction. L'entryId vient uniquement du chemin.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; entryId: string }> },
  deps: MileageServiceDeps = { auth, db: prisma },
) {
  const { id, entryId } = await context.params
  return handleMileageCommand(request, { truckId: id, action: "CORRECTION", targetId: entryId }, deps)
}
