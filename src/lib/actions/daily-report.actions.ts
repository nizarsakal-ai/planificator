"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import type { WeatherCondition } from "@prisma/client"

export async function upsertDailyReport(formData: FormData) {
  const session = await auth()
  if (!session?.user || session.user.role !== "TEAM_LEADER") {
    return { error: "Non autorisé" }
  }

  const worksiteId  = formData.get("worksiteId") as string
  const teamId      = formData.get("teamId") as string
  const date        = formData.get("date") as string
  const weather     = formData.get("weather") as WeatherCondition
  const description = formData.get("description") as string
  const issues      = formData.get("issues") as string
  const hoursWorked = parseFloat(formData.get("hoursWorked") as string) || 0

  if (!worksiteId || !teamId || !date || !description) {
    return { error: "Champs obligatoires manquants" }
  }

  // Vérifier que le team leader est bien chef de cette équipe
  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id!, companyId: session.user.companyId! },
    select: { id: true },
  })
  if (!employee) return { error: "Employé introuvable" }

  const team = await prisma.team.findFirst({
    where: { id: teamId, leaderId: employee.id, companyId: session.user.companyId! },
  })
  if (!team) return { error: "Vous n'êtes pas chef de cette équipe" }

  const dateObj = new Date(date)

  await prisma.dailyReport.upsert({
    where: { teamId_date: { teamId, date: dateObj } },
    create: {
      worksiteId,
      teamId,
      createdById: employee.id,
      date: dateObj,
      weather,
      description,
      issues: issues || null,
      hoursWorked,
    },
    update: {
      weather,
      description,
      issues: issues || null,
      hoursWorked,
    },
  })

  revalidatePath("/planning/equipe")
  revalidatePath("/rapports")
  return { success: true }
}

export async function getDailyReport(teamId: string, date: string) {
  const session = await auth()
  if (!session?.user) return null

  return prisma.dailyReport.findUnique({
    where: { teamId_date: { teamId, date: new Date(date) } },
  })
}
