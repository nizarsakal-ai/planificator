import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { handleReminderSettingsGet, handleReminderSettingsPut } from "@/lib/vehicules/v3/document-api"
import { cloudinaryDocumentStorage } from "@/lib/vehicules/v3/document-storage.port"
import type { DocumentServiceDeps } from "@/lib/vehicules/v3/document-service"

// V3 Lot 1 — seuils de rappel de l'entreprise (administrateurs). Hors préfixe /api/trucks : règle PWA NetworkOnly dédiée.
export async function GET(request: Request, _context: unknown, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  return handleReminderSettingsGet(request, deps)
}

export async function PUT(request: Request, _context: unknown, deps: DocumentServiceDeps = { auth, db: prisma, storage: cloudinaryDocumentStorage }) {
  return handleReminderSettingsPut(request, deps)
}
