// Pièce d'une ligne d'un import en aperçu : privée (garde de session + société + appartenance au lot), jamais mise en cache.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireInvoiceImportRoute } from "@/lib/invoice-import/access"
import { getImportedFile } from "@/lib/invoice-import/import.service"
export const dynamic = "force-dynamic"
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const access = await requireInvoiceImportRoute()
  if (!access.ok) return access.response
  const absent = () => new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  const { id, fileId } = await params
  if (!id || id.length > 64 || !fileId || fileId.length > 64) return absent()
  const file = await getImportedFile(prisma, access.ctx.companyId, { batchId: id, fileId })
  if (!file) return absent()
  return new NextResponse(new Uint8Array(file.data), { headers: {
    "Content-Type": file.mime, "Content-Disposition": `inline; filename="${file.originalName.replace(/[^A-Za-z0-9._-]/g, "-")}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } })
}
