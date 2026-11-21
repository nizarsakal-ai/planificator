// 21/11/2026 — PDF d'un bon de commande fournisseur (module Achats). Même garde que les pages Achats.
import { NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { prisma } from "@/lib/prisma"
import { resolveStockAccess } from "@/lib/stock/access"
import { buildPurchaseOrderPdfData } from "@/lib/billing/pdf/purchase-order-pdf"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await resolveStockAccess()
  if (!access.ok) return new NextResponse(null, { status: access.reason === "UNAUTHENTICATED" ? 401 : 404, headers: { "Cache-Control": "no-store" } })
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return new NextResponse(null, { status: 404 })
  const data = await buildPurchaseOrderPdfData(prisma, access.context.companyId, id)
  if (!data) return new NextResponse(null, { status: 404 })
  const buffer = await renderToBuffer(<DocumentPdf data={data} />)
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${data.number.replace(/[^A-Za-z0-9._-]/g, "-")}.pdf"`, "Cache-Control": "no-store" },
  })
}
