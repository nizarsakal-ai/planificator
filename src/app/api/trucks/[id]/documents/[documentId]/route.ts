import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDocumentGet, handleDocumentUpdate } from "@/lib/vehicules/v3/document-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"
import type { DocumentServiceDeps } from "@/lib/vehicules/v3/document-service"

// V3 Lot 1 — détail d'un dossier et de toutes ses versions.
export async function GET(request: Request, context: { params: Promise<{ id: string; documentId: string }> }, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  const { id, documentId } = await context.params
  return handleDocumentGet(request, id, documentId, deps)
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; documentId: string }> }, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  const { id, documentId } = await context.params
  return handleDocumentUpdate(request, id, documentId, deps)
}
