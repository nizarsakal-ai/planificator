"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import bcrypt from "bcryptjs"
import { z } from "zod"

const updateProfilSchema = z.object({
  name:  z.string().min(1, "Le nom est requis").max(80),
  email: z.string().email("Email invalide"),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Mot de passe actuel requis"),
  newPassword:     z.string().min(8, "8 caractères minimum"),
  confirmPassword: z.string(),
}).refine((d) => d.newPassword === d.confirmPassword, {
  message: "Les mots de passe ne correspondent pas",
  path: ["confirmPassword"],
})

export async function updateProfil(formData: FormData) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")

  const raw = {
    name:  formData.get("name")  as string,
    email: formData.get("email") as string,
  }

  const parsed = updateProfilSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  // Vérifier que l'email n'est pas déjà pris par quelqu'un d'autre
  const existing = await prisma.user.findFirst({
    where: { email: parsed.data.email, NOT: { id: session.user.id } },
  })
  if (existing) return { error: "Cet email est déjà utilisé." }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { name: parsed.data.name, email: parsed.data.email },
  })

  revalidatePath("/profil")
  return { success: true }
}

export async function changePassword(formData: FormData) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")

  const raw = {
    currentPassword: formData.get("currentPassword") as string,
    newPassword:     formData.get("newPassword")     as string,
    confirmPassword: formData.get("confirmPassword") as string,
  }

  const parsed = changePasswordSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } })
  if (!user?.password) return { error: "Impossible de modifier le mot de passe." }

  const valid = await bcrypt.compare(parsed.data.currentPassword, user.password)
  if (!valid) return { error: "Mot de passe actuel incorrect." }

  const hashed = await bcrypt.hash(parsed.data.newPassword, 12)
  await prisma.user.update({ where: { id: session.user.id }, data: { password: hashed } })

  return { success: true }
}
