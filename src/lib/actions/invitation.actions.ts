"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { sendInvitationEmail } from "@/lib/email"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { inviterMembreImpl } from "@/lib/actions/invitation-invite.core"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role))
    throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Inviter un membre ────────────────────────────────────────────────────────

export async function inviterMembre(formData: FormData) {
  return inviterMembreImpl(formData, {
    requireSession: requireAdmin,
    findExistingUser: (email, companyId) =>
      prisma.user.findFirst({
        where: { email, companyId },
        include: { employeeProfile: { select: { id: true, active: true } } },
      }),
    deleteUser: (id) => prisma.user.delete({ where: { id } }),
    deletePendingInvitations: (email) =>
      prisma.invitation.deleteMany({
        where: { email, status: "PENDING" },
      }),
    findCompanyName: async (companyId) => {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { name: true },
      })
      return company?.name ?? null
    },
    createInvitation: (data) =>
      prisma.invitation.create({
        data: {
          ...data,
          status: "PENDING",
        },
      }),
    sendEmail: async ({ to, token, companyName, invitedByName, role }) => {
      await sendInvitationEmail({
        to,
        token,
        companyName,
        invitedByName,
        role,
      })
    },
    revalidate: () => revalidatePath("/employes"),
  })
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
  token: z.string().min(1),
  name: z.string().min(1, "Le nom est requis"),
  password: z.string().min(8, "8 caractères minimum"),
})

export async function acceptInvitation(formData: FormData) {
  const raw = {
    token: formData.get("token") as string,
    name: formData.get("name") as string,
    password: formData.get("password") as string,
  }

  const parsed = acceptSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const invitation = await prisma.invitation.findFirst({
    where: {
      token: parsed.data.token,
      status: "PENDING",
      expiresAt: { gt: new Date() },
    },
  })
  if (!invitation) return { error: "Invitation invalide ou expirée." }

  const existingUser = await prisma.user.findUnique({
    where: { email: invitation.email },
  })
  if (existingUser) return { error: "Un compte existe déjà avec cet email." }

  const hashed = await bcrypt.hash(parsed.data.password, 12)

  await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email: invitation.email,
        name: parsed.data.name,
        password: hashed,
        role: invitation.role,
        companyId: invitation.companyId,
      },
    })

    // Créer automatiquement le profil employé si rôle EMPLOYEE ou TEAM_LEADER
    if (["EMPLOYEE", "TEAM_LEADER"].includes(invitation.role)) {
      const [firstName, ...rest] = parsed.data.name.split(" ")
      await tx.employee.create({
        data: {
          userId: newUser.id,
          companyId: invitation.companyId,
          firstName: firstName || parsed.data.name,
          lastName: rest.join(" ") || "",
        },
      })
    }

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED" },
    })
  })

  return { success: true }
}
