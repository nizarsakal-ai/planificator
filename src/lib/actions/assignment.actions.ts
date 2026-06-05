"use server"

import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"

export async function checkTeamConflict(teamId: string, date: string, excludeWorksiteId?: string) {
  const session = await auth()
  if (!session?.user) return null

  const existing = await prisma.assignment.findFirst({
    where: {
      teamId,
      date: new Date(date),
      ...(excludeWorksiteId ? { worksiteId: { not: excludeWorksiteId } } : {}),
    },
    include: {
      worksite: { select: { name: true } },
    },
  })

  return existing ? { worksiteName: existing.worksite.name } : null
}
