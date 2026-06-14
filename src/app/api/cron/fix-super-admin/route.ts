// ENDPOINT TEMPORAIRE — À SUPPRIMER APRÈS USAGE
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const email = new URL(req.url).searchParams.get("email")
  const companyId = new URL(req.url).searchParams.get("companyId")
  if (!email || !companyId) return NextResponse.json({ error: "email and companyId params required" }, { status: 400 })

  const updated = await prisma.user.update({
    where: { email },
    data:  { role: "SUPER_ADMIN", companyId },
    select: { id: true, email: true, role: true, companyId: true },
  })

  return NextResponse.json({ ok: true, user: updated })
}
