import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const [deletedPending, deletedAccommodations] = await Promise.all([
    prisma.pendingAccommodation.deleteMany({}),
    prisma.accommodation.deleteMany({
      where: { endDate: { lt: today } },
    }),
  ])

  return NextResponse.json({
    ok: true,
    deletedPending: deletedPending.count,
    deletedAccommodations: deletedAccommodations.count,
  })
}
