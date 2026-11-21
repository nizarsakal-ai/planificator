// 21/11/2026 — PDF d'un bon de livraison. Même garde que les factures et devis.
import { NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { prisma } from "@/lib/prisma"
import { requireBillingRoute } from "@/lib/billing/access"
import { buildDeliveryNotePdfData } from "@/lib/billing/pdf/commercial-pdf"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireBillingRoute()
  if (!access.ok) return access.response
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return new NextResponse(null, { status: 404 })
  const data = await buildDeliveryNotePdfData(prisma, access.ctx.companyId, id)
  if (!data) return new NextResponse(null, { status: 404 })
  const buffer = await renderToBuffer(<DocumentPdf data={data} />)
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${data.number.replace(/[^A-Za-z0-9._-]/g, "-")}.pdf"`, "Cache-Control": "no-store" } })
}
