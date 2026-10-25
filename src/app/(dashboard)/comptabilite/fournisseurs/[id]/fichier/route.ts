import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireAccountingRoute } from "@/lib/accounting/ui/route-guard"
import { getSupplierInvoiceFile } from "@/lib/accounting/c5/supplier-invoice.service"

export const dynamic = "force-dynamic"

/** Pièce jointe d'une facture fournisseur (société de session uniquement) — jamais mise en cache. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireAccountingRoute()
  if (!access.ok) return access.response
  void request.url
  const { id } = await params
  if (typeof id !== "string" || id.length > 64) return new NextResponse(null, { status: 404 })
  const file = await getSupplierInvoiceFile(prisma, access.ctx, id)
  if (!file) return new NextResponse(null, { status: 404 })
  return new NextResponse(new Uint8Array(file.data), { status: 200, headers: { "Content-Type": file.mime, "Content-Disposition": `inline; filename="${file.originalName.replace(/[^A-Za-z0-9._-]/g, "-")}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })
}
