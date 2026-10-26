import { NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { prisma } from "@/lib/prisma"
import { requireBillingRoute } from "@/lib/billing/access"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { DocumentIntegrityError } from "@/lib/billing/document-integrity"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireBillingRoute()
  if (!access.ok) return access.response
  const { id } = await params
  if (typeof id !== "string" || id.length > 64) return new NextResponse(null, { status: 404 })
  let data
  try {
    data = await buildInvoicePdfData(prisma, access.ctx.companyId, id)
  } catch (e) {
    // P1-01 : pièce émise incohérente (totaux stockés ≠ recalcul) ⇒ refus explicite, jamais un PDF d'un autre montant.
    if (e instanceof DocumentIntegrityError) return new NextResponse(`Pièce ${e.documentNumber} refusée : totaux enregistrés différents du recalcul des lignes. Contactez l'administrateur.`, { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } })
    throw e
  }
  if (!data) return new NextResponse(null, { status: 404 })
  const buffer = await renderToBuffer(<DocumentPdf data={data} />)
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${data.number.replace(/[^A-Za-z0-9._-]/g, "-")}.pdf"`, "Cache-Control": "no-store" },
  })
}
