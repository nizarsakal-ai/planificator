import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDocumentsGet, handleDocumentUpload } from "@/lib/vehicules/v3/document-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"
import type { DocumentServiceDeps } from "@/lib/vehicules/v3/document-service"

// V3 Lot 1 — dossiers documentaires d'un camion : liste et ajout (multipart `file` + `payload`).
export async function GET(request: Request, context: { params: Promise<{ id: string }> }, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  return handleDocumentsGet(request, (await context.params).id, deps)
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  return handleDocumentUpload(request, (await context.params).id, deps)
}
