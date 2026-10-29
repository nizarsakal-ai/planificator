import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { logoDataUrlToPng } from "@/lib/company-logo"

export const dynamic = "force-dynamic"

/** Téléchargement du logo enregistré — ADMIN / SUPER_ADMIN, société de session uniquement (jamais d'identifiant en entrée). */
export async function GET() {
  const session = await auth()
  if (!session?.user) return new NextResponse(null, { status: 401, headers: { "Cache-Control": "no-store" } })
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role) || !session.user.companyId) return new NextResponse(null, { status: 403, headers: { "Cache-Control": "no-store" } })
  const company = await prisma.company.findUnique({ where: { id: session.user.companyId }, select: { slug: true, logoUrl: true } })
  const png = logoDataUrlToPng(company?.logoUrl)
  if (!company || !png) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  const filename = `logo-${company.slug.replace(/[^A-Za-z0-9._-]/g, "-")}.png`
  return new NextResponse(new Uint8Array(png), {
    status: 200,
    headers: { "Content-Type": "image/png", "Content-Length": String(png.length), "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" },
  })
}
