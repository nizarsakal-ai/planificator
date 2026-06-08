"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"

// ─── Pointer l'arrivée ───────────────────────────────────────────────────────

export async function clockIn(lat: number, lng: number, worksiteId?: string) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")

  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id, companyId: session.user.companyId! },
  })
  if (!employee) return { error: "Profil employé introuvable." }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Upsert : si pointage du jour déjà créé, on met à jour ; sinon on crée
  const existing = await prisma.timeclock.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: today } },
  })

  if (existing?.checkInAt) return { error: "Vous avez déjà pointé votre arrivée aujourd'hui." }

  await prisma.timeclock.upsert({
    where: { employeeId_date: { employeeId: employee.id, date: today } },
    create: {
      employeeId: employee.id,
      companyId:  session.user.companyId!,
      worksiteId: worksiteId || null,
      date:       today,
      checkInAt:  new Date(),
      checkInLat: lat,
      checkInLng: lng,
    },
    update: {
      checkInAt:  new Date(),
      checkInLat: lat,
      checkInLng: lng,
      worksiteId: worksiteId || null,
    },
  })

  revalidatePath("/pointage")
  revalidatePath("/pointages")
  return { success: true }
}

// ─── Pointer le départ ───────────────────────────────────────────────────────

export async function clockOut(lat: number, lng: number) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")

  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id, companyId: session.user.companyId! },
  })
  if (!employee) return { error: "Profil employé introuvable." }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const existing = await prisma.timeclock.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: today } },
  })

  if (!existing?.checkInAt) return { error: "Vous devez d'abord pointer votre arrivée." }
  if (existing.checkOutAt)  return { error: "Vous avez déjà pointé votre départ aujourd'hui." }

  await prisma.timeclock.update({
    where: { id: existing.id },
    data: {
      checkOutAt:  new Date(),
      checkOutLat: lat,
      checkOutLng: lng,
    },
  })

  revalidatePath("/pointage")
  revalidatePath("/pointages")
  return { success: true }
}

// ─── Pointage du jour (pour l'employé) ───────────────────────────────────────

export async function getTodayTimeclock() {
  const session = await auth()
  if (!session?.user) return null

  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id, companyId: session.user.companyId! },
  })
  if (!employee) return null

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return prisma.timeclock.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: today } },
    include: { worksite: { select: { name: true } } },
  })
}

// ─── Historique des pointages (employé) ──────────────────────────────────────

export async function getMyTimeclocks(limit = 14) {
  const session = await auth()
  if (!session?.user) return []

  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id, companyId: session.user.companyId! },
  })
  if (!employee) return []

  return prisma.timeclock.findMany({
    where: { employeeId: employee.id },
    include: { worksite: { select: { name: true } } },
    orderBy: { date: "desc" },
    take: limit,
  })
}

// ─── Tous les pointages (admin) ───────────────────────────────────────────────

export async function getAllTimeclocks(dateFrom?: Date, dateTo?: Date) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const from = dateFrom ?? today
  const to   = dateTo   ?? today

  return prisma.timeclock.findMany({
    where: {
      companyId: session.user.companyId!,
      date: { gte: from, lte: to },
    },
    include: {
      employee: { select: { firstName: true, lastName: true, avatarUrl: true } },
      worksite: { select: { name: true } },
    },
    orderBy: [{ date: "desc" }, { checkInAt: "asc" }],
  })
}
