import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { resolveSupplierIntakeAccess } from "@/lib/supplier-intake/access"
import { intakeInvoiceScope } from "@/lib/supplier-intake/access.core"
export const dynamic = "force-dynamic"
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveSupplierIntakeAccess()
  const absent = () => new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  if (!ctx) return absent()
  const { id } = await params
  if (!id || id.length > 64) return absent()
  const invoice = await prisma.supplierInvoice.findFirst({ where: { id, ...intakeInvoiceScope(ctx) }, select: { fileId: true } })
  if (!invoice?.fileId) return absent()
  const file = await prisma.supplierInvoiceFile.findFirst({ where: { id: invoice.fileId, companyId: ctx.companyId }, select: { data: true, mime: true, originalName: true } })
  if (!file) return absent()
  return new NextResponse(new Uint8Array(file.data), { headers: {
    "Content-Type": file.mime, "Content-Disposition": `inline; filename="${file.originalName.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } })
}
