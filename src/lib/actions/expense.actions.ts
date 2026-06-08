"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { z } from "zod"
import { v2 as cloudinary } from "cloudinary"

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const createSchema = z.object({
  date:        z.string().min(1, "La date est requise"),
  amount:      z.coerce.number().positive("Le montant doit être positif"),
  category:    z.enum(["TRANSPORT", "REPAS", "HEBERGEMENT", "MATERIEL", "OTHER"]),
  description: z.string().min(1, "La description est requise").max(500),
})

// ─── Soumettre une note de frais (employé) ───────────────────────────────────

export async function createExpenseReport(formData: FormData) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")

  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id, companyId: session.user.companyId! },
  })
  if (!employee) return { error: "Profil employé introuvable." }

  const raw = {
    date:        formData.get("date")        as string,
    amount:      formData.get("amount")      as string,
    category:    formData.get("category")    as string,
    description: formData.get("description") as string,
  }

  const parsed = createSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  // Upload justificatif (optionnel)
  let receiptUrl: string | null = null
  const receiptFile = formData.get("receipt") as File | null
  if (receiptFile && receiptFile.size > 0) {
    try {
      const arrayBuffer = await receiptFile.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const uploadResult = await new Promise<{ secure_url: string }>((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: `planificator/${session.user.companyId}/receipts`, resource_type: "image" },
          (err, res) => { if (err || !res) return reject(err); resolve(res) }
        ).end(buffer)
      })
      receiptUrl = uploadResult.secure_url
    } catch {
      // Upload échoué, on continue sans justificatif
    }
  }

  await prisma.expenseReport.create({
    data: {
      employeeId:  employee.id,
      companyId:   session.user.companyId!,
      date:        new Date(parsed.data.date),
      amount:      parsed.data.amount,
      category:    parsed.data.category,
      description: parsed.data.description,
      receiptUrl,
    },
  })

  // Notifier les admins
  const admins = await prisma.user.findMany({
    where: { companyId: session.user.companyId!, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
    select: { id: true },
  })
  if (admins.length > 0) {
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId:    a.id,
        companyId: session.user.companyId!,
        type:      "EXPENSE_SUBMITTED" as const,
        title:     `Note de frais — ${employee.firstName} ${employee.lastName}`,
        message:   `${parsed.data.amount.toFixed(2)} € · ${parsed.data.description}`,
        link:      "/notes-de-frais",
      })),
    })
  }

  revalidatePath("/mes-notes-de-frais")
  revalidatePath("/notes-de-frais")
  return { success: true }
}

// ─── Approuver / Refuser (admin) ─────────────────────────────────────────────

export async function updateExpenseStatus(
  id: string,
  status: "APPROVED" | "REJECTED",
  rejectionNote?: string
) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")

  if (status === "REJECTED" && !rejectionNote?.trim()) {
    return { error: "La raison du refus est obligatoire." }
  }

  const expense = await prisma.expenseReport.findFirst({
    where: { id, companyId: session.user.companyId! },
    include: { employee: { include: { user: { select: { id: true } } } } },
  })
  if (!expense) return { error: "Note de frais introuvable." }

  await prisma.expenseReport.update({
    where: { id },
    data: { status, rejectionNote: rejectionNote || null, approvedById: session.user.id },
  })

  // Notifier l'employé
  await prisma.notification.create({
    data: {
      userId:    expense.employee.user.id,
      companyId: session.user.companyId!,
      type:      status === "APPROVED" ? "EXPENSE_APPROVED" : "EXPENSE_REJECTED",
      title:     status === "APPROVED" ? "Note de frais approuvée" : "Note de frais refusée",
      message:   status === "APPROVED"
        ? `Votre note de ${expense.amount.toFixed(2)} € a été approuvée.`
        : `Votre note de ${expense.amount.toFixed(2)} € a été refusée.${rejectionNote ? ` Raison : ${rejectionNote}` : ""}`,
      link: "/mes-notes-de-frais",
    },
  })

  revalidatePath("/notes-de-frais")
  revalidatePath("/mes-notes-de-frais")
  return { success: true }
}

// ─── Supprimer (admin ou propriétaire si PENDING) ────────────────────────────

export async function deleteExpenseReport(id: string) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")

  const expense = await prisma.expenseReport.findFirst({
    where: { id, companyId: session.user.companyId! },
    include: { employee: true },
  })
  if (!expense) return { error: "Note de frais introuvable." }

  const isAdmin = ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)
  const isOwner = expense.employee.userId === session.user.id && expense.status === "PENDING"

  if (!isAdmin && !isOwner) return { error: "Accès refusé." }

  await prisma.expenseReport.delete({ where: { id } })

  revalidatePath("/notes-de-frais")
  revalidatePath("/mes-notes-de-frais")
  return { success: true }
}
