import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleTruckDelete, handleTruckPatch } from "@/lib/vehicules/trucks-api"

// Modification : SUPER_ADMIN / ADMIN / TEAM_LEADER ; DELETE = archivage, SUPER_ADMIN / ADMIN (droits inchangés).
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleTruckPatch(req, (await context.params).id, { auth, db: prisma })
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  return handleTruckDelete((await context.params).id, { auth, db: prisma })
}
