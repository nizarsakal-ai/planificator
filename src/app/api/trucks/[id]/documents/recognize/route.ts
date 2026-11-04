import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDocumentRecognize } from "@/lib/vehicules/v3/document-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"
import type { DocumentRecognitionDeps } from "@/lib/vehicules/v3/document-recognition-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

// V3 — lecture d'une pièce avant ajout (multipart `file` + `payload` {category}) : proposition de champs, aucune écriture.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }, deps: DocumentRecognitionDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  return handleDocumentRecognize(request, (await context.params).id, deps)
}
