import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMaintenanceGet, handleMaintenancePost } from "@/lib/vehicules/maintenance-api"
import type { MaintenanceServiceDeps } from "@/lib/vehicules/maintenance-service"
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }, deps: MaintenanceServiceDeps = { auth, db: prisma }) {
  return handleMaintenanceGet((await context.params).id, deps)
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }, deps: MaintenanceServiceDeps = { auth, db: prisma }) {
  return handleMaintenancePost(request, (await context.params).id, deps)
}
