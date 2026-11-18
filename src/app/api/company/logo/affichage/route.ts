import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { companyLogoVersion, logoDataUrlToPng } from "@/lib/company-logo"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "private, no-store" }

/**
 * Affichage du logo géré dans la coquille du tableau de bord (correctif #418, voir `companyLogoDisplaySrc`).
 * Mêmes destinataires que la coquille qui l'affichait déjà : session interne avec société active (jamais CLIENT),
 * société de session uniquement (aucun identifiant de société en entrée).
 * Contrat de version : `v` doit être EXACTEMENT la version du logo de la société de session (`companyLogoVersion`) ;
 * sinon 404 sans corps (aucun autre logo n'est renvoyé sous une version étrangère, par exemple l'adresse calculée pour la
 * société A demandée alors que la session est passée à la société B). Réponses `private, no-store` ; le service worker
 * applique NetworkOnly à cette seule route (next.config.ts). Seul un PNG normalisé validé est servi, en ligne.
 * Le téléchargement reste `/api/company/logo`.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user) return new NextResponse(null, { status: 401, headers: NO_STORE })
  if (session.user.role === "CLIENT" || !session.user.companyId) return new NextResponse(null, { status: 403, headers: NO_STORE })
  const demandee = new URL(request.url).searchParams.getAll("v")
  if (demandee.length !== 1 || !/^[0-9a-f]{16}$/.test(demandee[0])) return new NextResponse(null, { status: 404, headers: NO_STORE })
  const company = await prisma.company.findUnique({ where: { id: session.user.companyId }, select: { logoUrl: true } })
  const png = logoDataUrlToPng(company?.logoUrl)
  if (!png || companyLogoVersion(company?.logoUrl) !== demandee[0]) return new NextResponse(null, { status: 404, headers: NO_STORE })
  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: { ...NO_STORE, "Content-Type": "image/png", "Content-Length": String(png.length), "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" },
  })
}
