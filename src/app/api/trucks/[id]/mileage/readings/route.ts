import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMileageCommand } from "@/lib/vehicules/mileage-api"
import type { MileageServiceDeps } from "@/lib/vehicules/mileage-service"

// Relevé autonome. L'action READING est fixée par cette route.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
  deps: MileageServiceDeps = { auth, db: prisma },
) {
  return handleMileageCommand(request, { truckId: (await context.params).id, action: "READING" }, deps)
}
