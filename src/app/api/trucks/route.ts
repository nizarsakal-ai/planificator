import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleTrucksGet, handleTrucksPost } from "@/lib/vehicules/trucks-api"

// Lecture : SUPER_ADMIN / ADMIN / TEAM_LEADER ; création : idem (droits inchangés).
export async function GET() {
  return handleTrucksGet({ auth, db: prisma })
}

export async function POST(req: Request) {
  return handleTrucksPost(req, { auth, db: prisma })
}
