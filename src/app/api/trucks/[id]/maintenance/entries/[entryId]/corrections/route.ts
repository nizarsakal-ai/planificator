import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMaintenanceCorrectionPost } from "@/lib/vehicules/maintenance-api"
import type { MaintenanceServiceDeps } from "@/lib/vehicules/maintenance-service"
export async function POST(request: Request, context: { params: Promise<{ id: string; entryId: string }> }, deps: MaintenanceServiceDeps = { auth, db: prisma }) {
  const { id, entryId } = await context.params
  return handleMaintenanceCorrectionPost(request, id, entryId, deps)
}
