// Lot D Planificator V2 : PDF d'un procès-verbal de réception, régénéré depuis son instantané figé. Si l'empreinte de
// l'instantané OU celle des octets de la signature ne correspond plus, le PDF est refusé (409) plutôt que produit sur
// des données altérées.
// Drapeau WORKSITE_RESERVES_ENABLED + ADMIN/SUPER_ADMIN ; procès-verbal d'une autre entreprise ⇒ 404.
import { NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { prisma } from "@/lib/prisma"
import { reserveDenialStatus, resolveReserveAccess } from "@/lib/reserves/access"
import { getReportForPdf } from "@/lib/reserves/queries"
import { ReceptionReportDocument } from "@/lib/reserves/report-pdf"
import { snapshotSha256 } from "@/lib/reserves/reserves.core"

export const dynamic = "force-dynamic"
const ID = /^[A-Za-z0-9_-]{1,64}$/
const none = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } })

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await resolveReserveAccess()
  if (!access.ok) return none(reserveDenialStatus(access.reason))
  const { id } = await params
  if (!ID.test(id)) return none(404)
  const report = await getReportForPdf(prisma, access.context.companyId, id)
  if (!report) return none(404)
  if (!report.intact) {
    console.error("[reserves] intégrité du procès-verbal non conforme", report.number, report.snapshotIntact ? "signature" : "instantané")
    return none(409)
  }
  const pdf = await renderToBuffer(<ReceptionReportDocument snapshot={report.snapshot} signaturePng={report.signaturePng} snapshotSha256={snapshotSha256(report.snapshot)} />)
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${report.number.replace(/[^A-Za-z0-9-]/g, "")}.pdf"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
