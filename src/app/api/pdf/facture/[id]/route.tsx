import { NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { prisma } from "@/lib/prisma"
import { requireBillingRoute } from "@/lib/billing/access"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireBillingRoute()
  if (!access.ok) return access.response
  const { id } = await params
  if (typeof id !== "string" || id.length > 64) return new NextResponse(null, { status: 404 })
  const data = await buildInvoicePdfData(prisma, access.ctx.companyId, id)
  if (!data) return new NextResponse(null, { status: 404 })
  const buffer = await renderToBuffer(<DocumentPdf data={data} />)
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${data.number.replace(/[^A-Za-z0-9._-]/g, "-")}.pdf"`, "Cache-Control": "no-store" },
  })
}
