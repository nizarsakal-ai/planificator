"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createAbsenceSchema } from "@/lib/validations/absence"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

export async function createAbsence(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    employeeId: formData.get("employeeId") as string,
    type:       formData.get("type")       as string,
    startDate:  formData.get("startDate")  as string,
    endDate:    formData.get("endDate")    as string,
    reason:     formData.get("reason")     as string,
  }

  const parsed = createAbsenceSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  // Vérifier que l'employé appartient à cette entreprise
  const employee = await prisma.employee.findFirst({
    where: { id: parsed.data.employeeId, companyId: user.companyId! },
  })
  if (!employee) return { error: "Employé introuvable." }

  await prisma.absence.create({
    data: {
      employeeId:  parsed.data.employeeId,
      companyId:   user.companyId!,
      type:        parsed.data.type,
      startDate:   new Date(parsed.data.startDate),
      endDate:     new Date(parsed.data.endDate),
      reason:      parsed.data.reason || null,
      status:      "PENDING",
      createdById: user.id,
    },
  })

  revalidatePath("/absences")
  return { success: true }
}

export async function updateAbsenceStatus(
  absenceId: string,
  status: "APPROVED" | "REJECTED"
) {
  const user = await requireAdmin()

  const absence = await prisma.absence.findFirst({
    where: { id: absenceId, companyId: user.companyId! },
  })
  if (!absence) return { error: "Absence introuvable." }

  await prisma.absence.update({
    where: { id: absenceId },
    data: { status },
  })

  revalidatePath("/absences")
  return { success: true }
}

export async function deleteAbsence(absenceId: string) {
  const user = await requireAdmin()

  const absence = await prisma.absence.findFirst({
    where: { id: absenceId, companyId: user.companyId! },
  })
  if (!absence) return { error: "Absence introuvable." }

  await prisma.absence.delete({ where: { id: absenceId } })

  revalidatePath("/absences")
  return { success: true }
}
