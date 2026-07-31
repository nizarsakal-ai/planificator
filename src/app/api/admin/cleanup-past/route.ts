import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"

export async function POST(req: Request) {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Seulement supprimer les pending dont la date de fin est dépassée depuis plus de 30 jours
  const pendingCutoff = new Date(today.getTime() - 30 * 86400000)

  // Seulement supprimer les logements terminés depuis plus de 90 jours
  const accomCutoff = new Date(today.getTime() - 90 * 86400000)

  const [deletedPending, deletedAccommodations] = await Promise.all([
    prisma.pendingAccommodation.deleteMany({
      where: {
        AND: [
          { status: "PENDING" },
          { endDate: { lt: pendingCutoff } },
        ],
      },
    }),
    prisma.accommodation.deleteMany({
      where: {
        status: { in: ["COMPLETED", "CANCELLED"] },
        endDate: { lt: accomCutoff },
      },
    }),
  ])

  return NextResponse.json({
    ok: true,
    deletedPending: deletedPending.count,
    deletedAccommodations: deletedAccommodations.count,
  })
}
