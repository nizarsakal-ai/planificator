import { prisma } from "@/lib/prisma"
import { resolveConnectorAccess } from "@/lib/connectors/access"
import { handleGoogleCalendarConnect } from "@/lib/integration/connectors/oauth/google-calendar-routes"

// LOT-8C — démarrage OAuth Google Agenda (lecture seule). Enveloppe fine : règles dans google-calendar-routes.ts.
export const dynamic = "force-dynamic"
export async function GET(request: Request): Promise<Response> {
  return handleGoogleCalendarConnect(request, { access: resolveConnectorAccess, db: prisma })
}
