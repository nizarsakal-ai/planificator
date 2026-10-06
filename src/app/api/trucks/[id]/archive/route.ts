import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleTruckArchive } from "@/lib/vehicules/trucks-api"

// Archivage : SUPER_ADMIN / ADMIN (idempotent, historique conservé).
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  return handleTruckArchive((await context.params).id, { auth, db: prisma })
}
