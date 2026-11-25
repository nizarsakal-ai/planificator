import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { buildPersonalDataExport, exportFileName } from "@/lib/account/personal-data-export"
import { collectPersonalData } from "@/lib/account/personal-data-export.prisma"

// Lot 2b juridique : « Télécharger mes données ». Uniquement les données du compte connecté.
export const dynamic = "force-dynamic"

export async function GET() {
  const userId = (await auth())?.user?.id
  if (!userId) return Response.json({ error: "Non authentifié" }, { status: 401 })

  const source = await collectPersonalData(prisma, userId)
  if (!source) return Response.json({ error: "Compte introuvable" }, { status: 404 })

  const now = new Date()
  return new Response(JSON.stringify(buildPersonalDataExport(source, now), null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(now)}"`,
      "Cache-Control": "no-store",
    },
  })
}
