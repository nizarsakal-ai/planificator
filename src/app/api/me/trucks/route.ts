import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleMyTrucks } from "@/lib/vehicules/v3/driver-fuel-ticket-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"

export const dynamic = "force-dynamic"

/** GET /api/me/trucks — camions dont l'utilisateur est le chauffeur attitré. */
export async function GET(request: Request) {
  return handleMyTrucks(request, { auth, db: prisma, storage: cloudinaryDocumentStorage })
}
