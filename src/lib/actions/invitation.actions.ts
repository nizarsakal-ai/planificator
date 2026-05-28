"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { sendInvitationEmail } from "@/lib/email"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { z } from "zod"

const inviteSchema = z.object({
  email: z.string().email("Email invalide"),
  role:  z.enum(["ADMIN", "TEAM_LEADER", "EMPLOYEE"]),
})

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Inviter un membre ────────────────────────────────────────────────────────

export async function inviterMembre(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    email: formData.get("email") as string,
    role:  formData.get("role")  as string,
  }

  const parsed = inviteSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  // Vérifier que l'utilisateur n'existe pas déjà
  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (existing) return { error: "Un compte existe déjà avec cet email." }

  // Vérifier qu'il n'y a pas déjà une invitation en attente
  const pendingInvite = await prisma.invitation.findFirst({
    where: { email: parsed.data.email, status: "PENDING" },
  })
  if (pendingInvite) return { error: "Une invitation est déjà en attente pour cet email." }

  const company = await prisma.company.findUnique({
    where: { id: user.companyId! },
    select: { name: true },
  })

  const token   = crypto.randomBytes(32).toString("hex")
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 jours

  await prisma.invitation.create({
    data: {
      email:       parsed.data.email,
      role:        parsed.data.role,
      companyId:   user.companyId!,
      invitedById: user.id,
      token,
      expiresAt:   expires,
      status:      "PENDING",
    },
  })

  // Envoyer l'email si RESEND_API_KEY est configuré
  if (process.env.RESEND_API_KEY) {
    await sendInvitationEmail({
      to:            parsed.data.email,
      token,
      companyName:   company?.name ?? "votre entreprise",
      invitedByName: user.name ?? user.email ?? "Admin",
      role:          parsed.data.role,
    })
  }

  const appUrl = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  const invitationUrl = `${appUrl}/invitation?token=${token}`

  revalidatePath("/employes")
  return { success: true, invitationUrl }
}

// ─── Accepter une invitation ──────────────────────────────────────────────────

export async function getInvitation(token: string) {
  const invitation = await prisma.invitation.findFirst({
    where: { token, status: "PENDING", expiresAt: { gt: new Date() } },
    include: { company: { select: { name: true } } },
  })
  return invitation
}

const acceptSchema = z.object({
  token:    z.string().min(1),
  name:     z.string().min(1, "Le nom est requis"),
  password: z.string().min(8, "8 caractères minimum"),
})

export async function acceptInvitation(formData: FormData) {
  const raw = {
    token:    formData.get("token")    as string,
    name:     formData.get("name")     as string,
    password: formData.get("password") as string,
  }

  const parsed = acceptSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const invitation = await prisma.invitation.findFirst({
    where: { token: parsed.data.token, status: "PENDING", expiresAt: { gt: new Date() } },
  })
  if (!invitation) return { error: "Invitation invalide ou expirée." }

  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email } })
  if (existingUser) return { error: "Un compte existe déjà avec cet email." }

  const hashed = await bcrypt.hash(parsed.data.password, 12)

  await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email:     invitation.email,
        name:      parsed.data.name,
        password:  hashed,
        role:      invitation.role,
        companyId: invitation.companyId,
      },
    })

    // Créer automatiquement le profil employé si rôle EMPLOYEE ou TEAM_LEADER
    if (["EMPLOYEE", "TEAM_LEADER"].includes(invitation.role)) {
      const [firstName, ...rest] = parsed.data.name.split(" ")
      await tx.employee.create({
        data: {
          userId:    newUser.id,
          companyId: invitation.companyId,
          firstName: firstName || parsed.data.name,
          lastName:  rest.join(" ") || "",
        },
      })
    }

    await tx.invitation.update({
      where: { id: invitation.id },
      data:  { status: "ACCEPTED" },
    })
  })

  return { success: true }
}
