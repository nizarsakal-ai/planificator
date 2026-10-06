"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { sendInvitationEmail } from "@/lib/email"
import bcrypt from "bcryptjs"
import { inviterMembreImpl } from "@/lib/actions/invitation-invite.core"
import { acceptInvitationImpl, type AcceptableInvitation } from "@/lib/actions/invitation-accept.core"

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
        select: {
          id: true,
          active: true,
          role: true,
          companyId: true,
          employeeProfile: { select: { id: true, active: true, companyId: true } },
        },
      }),
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

export async function acceptInvitation(formData: FormData) {
  return acceptInvitationImpl(formData, {
    findInvitation: async (token) => {
      const invitation = await prisma.invitation.findFirst({
        where: { token, status: "PENDING", expiresAt: { gt: new Date() } },
      })
      return invitation as AcceptableInvitation | null
    },
    findUserByEmail: (email) =>
      prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          active: true,
          role: true,
          companyId: true,
          employeeProfile: { select: { id: true, active: true, companyId: true } },
        },
      }),
    hashPassword: (password) => bcrypt.hash(password, 12),
    createMember: ({ invitation, name, password }) =>
      prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: invitation.email,
            name,
            password,
            role: invitation.role,
            companyId: invitation.companyId,
          },
        })

        // Créer automatiquement le profil employé si rôle EMPLOYEE ou TEAM_LEADER
        if (["EMPLOYEE", "TEAM_LEADER"].includes(invitation.role)) {
          const [firstName, ...rest] = name.split(" ")
          await tx.employee.create({
            data: {
              userId: newUser.id,
              companyId: invitation.companyId,
              firstName: firstName || name,
              lastName: rest.join(" ") || "",
            },
          })
        }

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: "ACCEPTED" },
        })
      }),
    reactivateMember: async ({ invitationId, userId, employeeId, companyId, role, name, password }) => {
      try {
        await prisma.$transaction(async (tx) => {
          // Gardés par l'état attendu : si l'identité a changé entre la lecture et l'écriture, rien n'est écrit.
          const u = await tx.user.updateMany({
            where: { id: userId, companyId, active: false },
            data: { name, password, role, active: true },
          })
          const e = await tx.employee.updateMany({
            where: { id: employeeId, userId, companyId, active: false },
            data: { active: true },
          })
          if (u.count !== 1 || e.count !== 1) throw new IdentityStateChanged()
          await tx.invitation.update({ where: { id: invitationId }, data: { status: "ACCEPTED" } })
        })
        return true
      } catch (err) {
        if (err instanceof IdentityStateChanged) return false
        throw err
      }
    },
  })
}

class IdentityStateChanged extends Error {}
