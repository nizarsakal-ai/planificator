// ENDPOINT TEMPORAIRE — À SUPPRIMER APRÈS USAGE
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const email = new URL(req.url).searchParams.get("email")
  if (!email) return NextResponse.json({ error: "email param required" }, { status: 400 })

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true, firstName: true, lastName: true },
  })

  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

  const updated = await prisma.user.update({
    where: { id: user.id },
    data:  { role: "SUPER_ADMIN", companyId: null },
    select: { id: true, email: true, role: true },
  })

  return NextResponse.json({ ok: true, user: updated })
}
