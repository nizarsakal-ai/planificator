// Lot G Planificator V2 : PDF d'un document généré, régénéré depuis son instantané figé. Si l'empreinte ne correspond
// plus, le PDF est refusé (409) plutôt que produit sur des données altérées. Drapeau DOCUMENT_STUDIO_ENABLED +
// ADMIN/SUPER_ADMIN ; document d'une autre entreprise ⇒ 404.
// Lot G2 : logo géré de l'entreprise de session en en-tête (présentation seulement, jamais une URL externe).
import { NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { prisma } from "@/lib/prisma"
import { resolveStudioAccess, studioDenialStatus } from "@/lib/document-studio/access"
import { getGeneratedDocument } from "@/lib/document-studio/queries"
import { GeneratedDocumentPdf } from "@/lib/document-studio/document-pdf"

export const dynamic = "force-dynamic"
const ID = /^[A-Za-z0-9_-]{1,64}$/
const none = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } })
// Refus expliqué en clair : la liste « Télécharger un PDF » ne calcule plus l'empreinte, le lien y est donc toujours proposé.
const blocked = () => new NextResponse("Empreinte du contenu non conforme : le PDF de ce document est bloqué. Ouvrez la fiche du document dans le Studio pour plus de détails.", {
  status: 409,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
})

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await resolveStudioAccess()
  if (!access.ok) return none(studioDenialStatus(access.reason))
  const { id } = await params
  if (!ID.test(id)) return none(404)
  const d = await getGeneratedDocument(prisma, access.context.companyId, id)
  if (!d) return none(404)
  if (!d.intact || !d.snapshot) {
    console.error("[studio] empreinte d'instantané non conforme", d.number)
    return blocked()
  }
  const approval = d.status === "ISSUED" && d.approvedAt && d.signerName && d.signaturePng ? { signerName: d.signerName, approvedAt: d.approvedAt, signaturePng: d.signaturePng } : null
  const pdf = await renderToBuffer(<GeneratedDocumentPdf snapshot={d.snapshot} snapshotSha256={d.snapshotSha256} status={d.status} approval={approval} />)
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${d.number.replace(/[^A-Za-z0-9-]/g, "")}.pdf"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  })
}
