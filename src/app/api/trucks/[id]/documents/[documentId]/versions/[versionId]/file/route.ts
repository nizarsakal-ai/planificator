import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDocumentFile } from "@/lib/vehicules/v3/document-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"
import type { DocumentServiceDeps } from "@/lib/vehicules/v3/document-service"

// V3 Lot 1 — consultation (?dl=1 : téléchargement) par proxy privé ; aucune URL signée exposée.
export async function GET(request: Request, context: { params: Promise<{ id: string; documentId: string; versionId: string }> }, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  const { id, documentId, versionId } = await context.params
  return handleDocumentFile(request, id, documentId, versionId, deps)
}
