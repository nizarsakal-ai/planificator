"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import type { WeatherCondition } from "@prisma/client"
import {
  getDailyReportCore,
  upsertDailyReportCore,
  type DailyReportDeps,
} from "@/lib/actions/daily-report.core"

/** Adaptateur Prisma ; la logique et les règles d'isolation sont dans daily-report.core.ts (T2bis). */
const prismaDeps: DailyReportDeps = {
  auth,
  findEmployee: (where) => prisma.employee.findFirst({ where, select: { id: true } }),
  findTeam: (where) => prisma.team.findFirst({ where, select: { id: true } }),
  findWorksite: (where) => prisma.worksite.findFirst({ where, select: { id: true } }),
  findExistingReport: (where) =>
    prisma.dailyReport.findFirst({
      where,
      select: { id: true, worksiteId: true, worksite: { select: { companyId: true } } },
    }),
  upsertReport: (args) => prisma.dailyReport.upsert(args),
  findReport: (where) =>
    prisma.dailyReport.findFirst({ where }),
  revalidate: revalidatePath,
}

export async function upsertDailyReport(formData: FormData) {
  return upsertDailyReportCore(
    {
      worksiteId: formData.get("worksiteId") as string,
      teamId: formData.get("teamId") as string,
      date: formData.get("date") as string,
      weather: formData.get("weather") as WeatherCondition,
      description: formData.get("description") as string,
      issues: formData.get("issues") as string,
      hoursWorked: parseFloat(formData.get("hoursWorked") as string) || 0,
    },
    prismaDeps
  )
}

export async function getDailyReport(teamId: string, date: string) {
  return getDailyReportCore(teamId, date, prismaDeps)
}
