import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMileageGet } from "@/lib/vehicules/mileage-api"
import type { MileageServiceDeps } from "@/lib/vehicules/mileage-service"

// Lecture kilométrique. Le droit, le tenant et le DTO restent dans le Lot 1.
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
  deps: MileageServiceDeps = { auth, db: prisma },
) {
  return handleMileageGet((await context.params).id, deps)
}
