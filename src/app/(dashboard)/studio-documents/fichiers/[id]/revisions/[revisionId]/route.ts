// Document Studio — espace PDF : octets d'une révision (original ou version remplie), jamais publics. Drapeau
// DOCUMENT_STUDIO_ENABLED + ADMIN/SUPER_ADMIN ; PDF ou révision d'une autre entreprise ⇒ 404. Empreinte revérifiée avant
// envoi (409 si les octets ne correspondent plus). `?telecharger=1` : pièce jointe ; sinon affichage dans la page (la
// visionneuse lit la réponse en mémoire). Aucune mise en cache.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { resolveStudioAccess, studioDenialStatus } from "@/lib/document-studio/access"
import { getRevisionBytes } from "@/lib/document-studio/pdf-workspace.queries"
import { downloadName } from "@/lib/document-studio/pdf-workspace.core"
import { sha256Hex } from "@/lib/document-studio/canonical"

export const dynamic = "force-dynamic"
const ID = /^[A-Za-z0-9_-]{1,64}$/
const none = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } })

export async function GET(request: Request, { params }: { params: Promise<{ id: string; revisionId: string }> }): Promise<Response> {
  const access = await resolveStudioAccess()
  if (!access.ok) return none(studioDenialStatus(access.reason))
  const { id, revisionId } = await params
  if (!ID.test(id) || !ID.test(revisionId)) return none(404)
  const r = await getRevisionBytes(prisma, access.context.companyId, id, revisionId)
  if (!r) return none(404)
  if (sha256Hex(r.data) !== r.sha256) {
    console.error("[studio-pdf] empreinte de révision non conforme", revisionId)
    return none(409)
  }
  const attachment = new URL(request.url).searchParams.get("telecharger") === "1"
  return new NextResponse(new Uint8Array(r.data), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename="${downloadName(r.title, r.revision)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  })
}
