import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDriverTicketSubmit } from "@/lib/vehicules/v3/driver-fuel-ticket-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

/** POST /api/me/fuel-ticket — ticket du chauffeur : justificatif + plein (multipart `file` + `payload`, en-tête Idempotency-Key). */
export async function POST(request: Request) {
  return handleDriverTicketSubmit(request, { auth, db: prisma, storage: cloudinaryDocumentStorage })
}
