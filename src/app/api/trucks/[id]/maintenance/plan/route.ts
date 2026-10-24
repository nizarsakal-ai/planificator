import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMaintenancePlanPut } from "@/lib/vehicules/maintenance-api"
import type { MaintenanceServiceDeps } from "@/lib/vehicules/maintenance-service"
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }, deps: MaintenanceServiceDeps = { auth, db: prisma }) {
  return handleMaintenancePlanPut(request, (await context.params).id, deps)
}
