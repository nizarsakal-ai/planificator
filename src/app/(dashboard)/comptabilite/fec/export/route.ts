import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireAccountingRoute } from "@/lib/accounting/ui/route-guard"
import { buildFec } from "@/lib/accounting/c5/fec"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const access = await requireAccountingRoute()
  if (!access.ok) return access.response
  const id = new URL(request.url).searchParams.get("exercice")?.trim() ?? ""
  if (!id || id.length > 64) return new NextResponse(null, { status: 404 })
  const fec = await buildFec(prisma, access.ctx, id)
  if (!fec) return new NextResponse(null, { status: 404 })
  return new NextResponse(fec.content, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${fec.filename}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })
}
