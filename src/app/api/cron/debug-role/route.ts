// TEMPORAIRE — À SUPPRIMER
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const email = new URL(req.url).searchParams.get("email") ?? "nohisacstructures@gmail.com"
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true, companyId: true, active: true },
  })
  return NextResponse.json({ user, dbUrl: process.env.DATABASE_URL?.slice(0, 50) + "..." })
}
