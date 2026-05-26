"use server"

import { prisma } from "@/lib/prisma"
import { sendPasswordResetEmail } from "@/lib/email"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { z } from "zod"

export async function requestPasswordReset(formData: FormData) {
  const email = formData.get("email") as string
  if (!email) return { error: "Email requis." }

  const user = await prisma.user.findUnique({ where: { email } })

  // On ne révèle pas si l'email existe ou non (sécurité)
  if (!user) return { success: true }

  // Invalider les anciens tokens
  await prisma.passwordReset.updateMany({
    where: { userId: user.id, usedAt: null },
    data:  { usedAt: new Date() },
  })

  const token   = crypto.randomBytes(32).toString("hex")
  const expires = new Date(Date.now() + 60 * 60 * 1000) // 1 heure

  await prisma.passwordReset.create({
    data: { userId: user.id, token, expiresAt: expires },
  })

  if (process.env.RESEND_API_KEY) {
    await sendPasswordResetEmail({ to: email, token })
  }

  return { success: true, token: !process.env.RESEND_API_KEY ? token : undefined }
}

const resetSchema = z.object({
  token:           z.string().min(1),
  password:        z.string().min(8, "8 caractères minimum"),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: "Les mots de passe ne correspondent pas",
  path: ["confirmPassword"],
})

export async function resetPassword(formData: FormData) {
  const raw = {
    token:           formData.get("token")           as string,
    password:        formData.get("password")        as string,
    confirmPassword: formData.get("confirmPassword") as string,
  }

  const parsed = resetSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const reset = await prisma.passwordReset.findFirst({
    where: { token: parsed.data.token, usedAt: null, expiresAt: { gt: new Date() } },
  })
  if (!reset) return { error: "Lien invalide ou expiré." }

  const hashed = await bcrypt.hash(parsed.data.password, 12)

  await prisma.$transaction([
    prisma.user.update({ where: { id: reset.userId }, data: { password: hashed } }),
    prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
  ])

  return { success: true }
}
