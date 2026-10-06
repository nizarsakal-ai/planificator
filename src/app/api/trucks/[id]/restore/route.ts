import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleTruckRestore } from "@/lib/vehicules/trucks-api"

// Restauration : SUPER_ADMIN / ADMIN (idempotente, sans réaffectation implicite).
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  return handleTruckRestore((await context.params).id, { auth, db: prisma })
}
