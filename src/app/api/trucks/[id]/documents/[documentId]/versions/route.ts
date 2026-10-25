import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleDocumentReplace } from "@/lib/vehicules/v3/document-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"
import type { DocumentServiceDeps } from "@/lib/vehicules/v3/document-service"

// V3 Lot 1 — remplacement : nouvelle version, l'ancienne reste consultable.
export async function POST(request: Request, context: { params: Promise<{ id: string; documentId: string }> }, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  const { id, documentId } = await context.params
  return handleDocumentReplace(request, id, documentId, deps)
}
