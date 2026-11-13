// PDF d'origine d'une facture importée : privé (garde de session + société), jamais mis en cache.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireInvoiceImportRoute } from "@/lib/invoice-import/access"
import { getImportedFile } from "@/lib/invoice-import/import.service"
export const dynamic = "force-dynamic"
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInvoiceImportRoute()
  if (!access.ok) return access.response
  const absent = () => new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  const { id } = await params
  if (!id || id.length > 64) return absent()
  const file = await getImportedFile(prisma, access.ctx.companyId, { invoiceId: id })
  if (!file) return absent()
  return new NextResponse(new Uint8Array(file.data), { headers: {
    "Content-Type": file.mime, "Content-Disposition": `inline; filename="${file.originalName.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } })
}
