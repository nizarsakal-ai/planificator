"use server"

import { revalidatePath } from "next/cache"
import bcrypt from "bcryptjs"
import { v2 as cloudinary } from "cloudinary"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createEmployeSchema, updateEmployeSchema } from "@/lib/validations/employe"

// ─── Utilitaire : récupère la session et vérifie le rôle ────────────────────

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) {
    throw new Error("Accès refusé")
  }
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Créer un employé ────────────────────────────────────────────────────────

export async function createEmploye(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    firstName: formData.get("firstName") as string,
    lastName: formData.get("lastName") as string,
    email: formData.get("email") as string,
    jobTitle: formData.get("jobTitle") as string,
    phone: formData.get("phone") as string,
    password: formData.get("password") as string,
  }

  const parsed = createEmployeSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.errors[0].message }
  }

  const { firstName, lastName, email, jobTitle, phone, password } = parsed.data

  // Vérifier que l'email n'est pas déjà utilisé
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    return { error: "Cet email est déjà utilisé." }
  }

  const hashedPassword = await bcrypt.hash(password, 12)

  // Créer le compte User + le profil Employee en une transaction
  await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email,
        password: hashedPassword,
        role: "EMPLOYEE",
        companyId: user.companyId!,
      },
    })

    await tx.employee.create({
      data: {
        userId: newUser.id,
        companyId: user.companyId!,
        firstName,
        lastName,
        jobTitle: jobTitle || null,
        phone: phone || null,
      },
    })
  })

  revalidatePath("/employes")
  return { success: true }
}

// ─── Modifier un employé ─────────────────────────────────────────────────────

export async function updateEmploye(employeeId: string, formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    firstName: formData.get("firstName") as string,
    lastName: formData.get("lastName") as string,
    email: formData.get("email") as string,
    jobTitle: formData.get("jobTitle") as string,
    phone: formData.get("phone") as string,
    hiredAt: formData.get("hiredAt") as string,
  }

  const parsed = updateEmployeSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.errors[0].message }
  }

  // Vérifier que l'employé appartient bien à cette entreprise
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId: user.companyId! },
  })
  if (!employee) return { error: "Employé introuvable." }

  // Vérifier que le nouvel email n'est pas déjà utilisé par un autre compte
  const existingUser = await prisma.user.findFirst({
    where: { email: parsed.data.email, id: { not: employee.userId } },
  })
  if (existingUser) return { error: "Cet email est déjà utilisé par un autre compte." }

  await prisma.$transaction([
    prisma.employee.update({
      where: { id: employeeId },
      data: {
        firstName: parsed.data.firstName,
        lastName:  parsed.data.lastName,
        jobTitle:  parsed.data.jobTitle || null,
        phone:     parsed.data.phone    || null,
        hiredAt:   parsed.data.hiredAt  ? new Date(parsed.data.hiredAt) : null,
      },
    }),
    prisma.user.update({
      where: { id: employee.userId },
      data: { email: parsed.data.email },
    }),
  ])

  revalidatePath("/employes")
  revalidatePath(`/employes/${employeeId}`)
  return { success: true }
}

// ─── Mettre à jour l'avatar ───────────────────────────────────────────────────

export async function updateEmployeAvatar(employeeId: string, formData: FormData) {
  const user = await requireAdmin()

  const file = formData.get("file") as File | null
  if (!file || file.size === 0) return { error: "Aucun fichier sélectionné." }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId: user.companyId! },
  })
  if (!employee) return { error: "Employé introuvable." }

  const arrayBuffer = await file.arrayBuffer()
  const buffer      = Buffer.from(arrayBuffer)

  const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder:          `planificator/${user.companyId}/avatars`,
        resource_type:   "image",
        transformation:  [{ width: 300, height: 300, crop: "fill", gravity: "face" }],
        public_id:       `employee-${employeeId}`,
        overwrite:       true,
      },
      (err, res) => {
        if (err || !res) return reject(err)
        resolve(res)
      }
    ).end(buffer)
  })

  await prisma.employee.update({
    where: { id: employeeId },
    data:  { avatarUrl: result.secure_url },
  })

  revalidatePath("/employes")
  revalidatePath(`/employes/${employeeId}`)
  return { success: true, avatarUrl: result.secure_url }
}

// ─── Désactiver un employé ───────────────────────────────────────────────────

export async function toggleEmployeActive(employeeId: string, active: boolean) {
  const user = await requireAdmin()

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId: user.companyId! },
  })
  if (!employee) return { error: "Employé introuvable." }

  await prisma.$transaction([
    prisma.employee.update({
      where: { id: employeeId },
      data: { active },
    }),
    prisma.user.update({
      where: { id: employee.userId },
      data: { active },
    }),
  ])

  revalidatePath("/employes")
  return { success: true }
}
