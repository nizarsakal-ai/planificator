import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDocumentArchive } from "@/lib/vehicules/v3/document-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"
import type { DocumentServiceDeps } from "@/lib/vehicules/v3/document-service"

// V3 Lot 1 — archivage du dossier (aucune suppression).
export async function POST(request: Request, context: { params: Promise<{ id: string; documentId: string }> }, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  const { id, documentId } = await context.params
  return handleDocumentArchive(request, id, documentId, deps)
}
