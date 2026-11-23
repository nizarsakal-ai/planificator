// Lot D Planificator V2 : téléchargement d'une preuve de réserve. Toujours en pièce jointe (jamais affichée dans la
// page de l'application), type réel contrôlé à l'enregistrement, nosniff et bac à sable.
// Drapeau WORKSITE_RESERVES_ENABLED + ADMIN/SUPER_ADMIN ; fichier d'une autre entreprise ⇒ 404.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { reserveDenialStatus, resolveReserveAccess } from "@/lib/reserves/access"
import { getReserveFile } from "@/lib/reserves/queries"

export const dynamic = "force-dynamic"
const ID = /^[A-Za-z0-9_-]{1,64}$/
const none = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } })
const asciiName = (n: string) => n.normalize("NFD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "preuve"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await resolveReserveAccess()
  if (!access.ok) return none(reserveDenialStatus(access.reason))
  const { id } = await params
  if (!ID.test(id)) return none(404)
  const f = await getReserveFile(prisma, access.context.companyId, id)
  if (!f) return none(404)
  return new NextResponse(new Uint8Array(f.data), {
    status: 200,
    headers: {
      "Content-Type": f.mime,
      "Content-Disposition": `attachment; filename="${asciiName(f.originalName)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  })
}
