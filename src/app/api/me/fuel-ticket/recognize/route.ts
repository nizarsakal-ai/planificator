import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDriverTicketRecognize } from "@/lib/vehicules/v3/driver-fuel-ticket-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/** POST /api/me/fuel-ticket/recognize — lecture du ticket (multipart `file` + `payload` {truckId}), aucune écriture. */
export async function POST(request: Request) {
  return handleDriverTicketRecognize(request, { auth, db: prisma, storage: cloudinaryDocumentStorage })
}
