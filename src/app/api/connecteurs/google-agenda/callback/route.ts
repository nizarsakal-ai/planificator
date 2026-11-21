import { prisma } from "@/lib/prisma"
import { resolveConnectorAccess } from "@/lib/connectors/access"
import { handleGoogleCalendarCallback } from "@/lib/integration/connectors/oauth/google-calendar-routes"

// LOT-8C — retour OAuth Google Agenda (adresse déclarée dans le client OAuth dédié). Règles dans google-calendar-routes.ts.
export const dynamic = "force-dynamic"
export async function GET(request: Request): Promise<Response> {
  return handleGoogleCalendarCallback(request, { access: resolveConnectorAccess, db: prisma })
}
