"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createAbsenceSchema } from "@/lib/validations/absence"
import { sendAbsenceApprovedEmail, sendAbsenceRejectedEmail } from "@/lib/email"

const TYPE_LABELS: Record<string, string> = {
  VACATION: "Congé payé",
  SICK:     "Maladie",
  UNPAID:   "Congé sans solde",
  TRAINING: "Formation",
  OTHER:    "Autre",
}

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Créer une absence (admin) ────────────────────────────────────────────────

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

  const employee = await prisma.employee.findFirst({
    where: { id: parsed.data.employeeId, companyId: user.companyId! },
  })
  if (!employee) return { error: "Employé introuvable." }

  const start = new Date(parsed.data.startDate)
  const end   = new Date(parsed.data.endDate)

  // Détection de conflits avec les affectations
  const conflicts = await prisma.employeeAssignment.count({
    where: {
      employeeId: parsed.data.employeeId,
      date: { gte: start, lte: end },
      assignment: { status: { in: ["CONFIRMED", "PENDING"] } },
    },
  })

  await prisma.absence.create({
    data: {
      employeeId:  parsed.data.employeeId,
      companyId:   user.companyId!,
      type:        parsed.data.type,
      startDate:   start,
      endDate:     end,
      reason:      parsed.data.reason || null,
      status:      "PENDING",
      createdById: user.id,
    },
  })

  revalidatePath("/absences")
  return {
    success: true,
    warning: conflicts > 0
      ? `⚠ Cet employé a ${conflicts} affectation${conflicts > 1 ? "s" : ""} sur cette période.`
      : undefined,
  }
}

// ─── Demande d'absence par l'employé lui-même ─────────────────────────────────

export async function demanderAbsence(formData: FormData) {
  const session = await auth()
  if (!session?.user) return { error: "Non authentifié" }

  const employee = await prisma.employee.findUnique({
    where: { userId: session.user.id },
  })
  if (!employee) return { error: "Profil employé introuvable." }

  const raw = {
    employeeId: employee.id,
    type:       formData.get("type")       as string,
    startDate:  formData.get("startDate")  as string,
    endDate:    formData.get("endDate")    as string,
    reason:     formData.get("reason")     as string,
  }

  const parsed = createAbsenceSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const start = new Date(parsed.data.startDate)
  const end   = new Date(parsed.data.endDate)

  await prisma.absence.create({
    data: {
      employeeId:  employee.id,
      companyId:   employee.companyId,
      type:        parsed.data.type,
      startDate:   start,
      endDate:     end,
      reason:      parsed.data.reason || null,
      status:      "PENDING",
      createdById: session.user.id,
    },
  })

  revalidatePath("/mes-absences")
  return { success: true }
}

// ─── Approuver ou refuser (admin) ─────────────────────────────────────────────

export async function updateAbsenceStatus(
  absenceId: string,
  status: "APPROVED" | "REJECTED",
  refusalNote?: string
) {
  const user = await requireAdmin()

  if (status === "REJECTED" && !refusalNote?.trim()) {
    return { error: "Un motif de refus est requis." }
  }

  const absence = await prisma.absence.findFirst({
    where: { id: absenceId, companyId: user.companyId! },
    include: {
      employee: {
        select: {
          firstName: true,
          lastName:  true,
          user:      { select: { email: true } },
        },
      },
    },
  })
  if (!absence) return { error: "Absence introuvable." }

  await prisma.absence.update({
    where: { id: absenceId },
    data: {
      status,
      refusalNote:  status === "REJECTED" ? (refusalNote ?? null) : null,
      approvedById: status === "APPROVED" ? user.id : null,
    },
  })

  // Email à l'employé
  const empEmail = absence.employee.user?.email
  if (empEmail && process.env.RESEND_API_KEY) {
    const employeeName = `${absence.employee.firstName} ${absence.employee.lastName}`
    const typeLabel    = TYPE_LABELS[absence.type] ?? absence.type
    const fmt = (d: Date) =>
      new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d)

    if (status === "APPROVED") {
      sendAbsenceApprovedEmail({
        to: empEmail, employeeName, typeLabel,
        startDate: fmt(absence.startDate),
        endDate:   fmt(absence.endDate),
      }).catch(() => {})
    } else {
      sendAbsenceRejectedEmail({
        to: empEmail, employeeName, typeLabel,
        startDate:   fmt(absence.startDate),
        endDate:     fmt(absence.endDate),
        refusalNote: refusalNote ?? undefined,
      }).catch(() => {})
    }
  }

  revalidatePath("/absences")
  revalidatePath("/mes-absences")
  return { success: true }
}

// ─── Supprimer ────────────────────────────────────────────────────────────────

export async function deleteAbsence(absenceId: string) {
  const user = await requireAdmin()

  const absence = await prisma.absence.findFirst({
    where: { id: absenceId, companyId: user.companyId! },
  })
  if (!absence) return { error: "Absence introuvable." }

  await prisma.absence.delete({ where: { id: absenceId } })

  revalidatePath("/absences")
  revalidatePath("/mes-absences")
  return { success: true }
}
