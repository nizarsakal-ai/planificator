"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { sendInvitationEmail } from "@/lib/email"
import bcrypt from "bcryptjs"
import { IDENTITY_AMBIGUOUS, inviterMembreImpl } from "@/lib/actions/invitation-invite.core"
import { acceptInvitationImpl, acceptSchema, type AcceptableInvitation } from "@/lib/actions/invitation-accept.core"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role))
    throw new Error("Accès refusé")
  // Le SUPER_ADMIN peut ne porter aucune entreprise : le cœur exige alors une cible explicite.
  if (!session.user.companyId && session.user.role !== "SUPER_ADMIN") throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Inviter un membre ────────────────────────────────────────────────────────

export async function inviterMembre(formData: FormData) {
  return inviterMembreImpl(formData, {
    requireSession: requireAdmin,
    // Supervision (SUPER_ADMIN) : entreprise cible par id, existence et activité vérifiées côté serveur.
    findTargetCompany: (companyId) =>
      prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, active: true } }),
    // Une seule transaction : purge des invitations en attente de la cible, création, journal INVITED.
    // Le jeton n'est jamais journalisé.
    createSupervisedInvitation: ({ email, role, companyId, invitedById, token, expiresAt }) =>
      prisma.$transaction(async (tx) => {
        await tx.invitation.deleteMany({
          where: { email: { equals: email, mode: "insensitive" }, companyId, status: "PENDING" },
        })
        const invitation = await tx.invitation.create({
          data: { email, role, companyId, invitedById, token, expiresAt, status: "PENDING" },
          select: { id: true },
        })
        await tx.historyLog.create({
          data: {
            companyId,
            actorId: invitedById,
            action: "INVITED",
            entityType: "Invitation",
            entityId: invitation.id,
            detail: `Invitation ${role} adressée à ${email} par la supervision (SUPER_ADMIN)`,
          },
        })
        return invitation
      }),
    // Recherche d'identité insensible à la casse et déterministe : plusieurs lignes, ou une ligne d'une autre
    // casse que l'adresse normalisée, ⇒ ambiguïté refusée (jamais de sélection arbitraire).
    findExistingUser: async (email, companyId) => {
      const accounts = await prisma.user.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        select: {
          id: true,
          email: true,
          active: true,
          role: true,
          companyId: true,
          employeeProfiles: { where: { companyId }, select: { id: true, active: true, companyId: true, role: true } },
        },
      })
      if (accounts.length > 1) return IDENTITY_AMBIGUOUS
      const account = accounts[0]
      if (!account) return null
      if (account.email !== email) return IDENTITY_AMBIGUOUS
      // Identité d'une autre entreprise : comportement historique (rattachement à l'acceptation).
      if (account.companyId !== companyId && account.employeeProfiles.length === 0) return null
      return { ...account, companyId, role: account.employeeProfiles[0]?.role ?? account.role, employeeProfile: account.employeeProfiles[0] ?? null }
    },
    // T2bis — ne supprime que les invitations en attente de CETTE entreprise.
    deletePendingInvitations: (email, companyId) =>
      prisma.invitation.deleteMany({
        where: { email, companyId, status: "PENDING" },
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
  const parsed = acceptSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.errors[0].message }
  const invitation = await prisma.invitation.findFirst({ where: {
    token: parsed.data.token, status: "PENDING", expiresAt: { gt: new Date() }, company: { active: true },
  } })
  if (!invitation) return { error: "Invitation invalide ou expirée." }
  const existing = await prisma.user.findUnique({ where: { email: invitation.email } })
  if (existing?.active) {
    // An invitation never authorizes resetting an existing account's password.
    if (existing.role === "CLIENT" || existing.role === "SUPER_ADMIN"
      || !await bcrypt.compare(parsed.data.password, existing.password)) {
      return { error: "Pour rattacher un compte existant, saisissez son mot de passe actuel." }
    }
    try {
      await prisma.$transaction(async tx => {
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, status: "PENDING", expiresAt: { gt: new Date() } },
          data: { status: "ACCEPTED" },
        })
        if (claimed.count !== 1) throw new Error("Invitation déjà utilisée")
        const [firstName, ...rest] = parsed.data.name.split(" ")
        await tx.employee.upsert({
          where: { userId_companyId: { userId: existing.id, companyId: invitation.companyId } },
          create: { userId: existing.id, companyId: invitation.companyId, role: invitation.role,
            firstName, lastName: rest.join(" ") },
          update: { active: true, role: invitation.role },
        })
      })
      return { success: true }
    } catch { return { error: "Invitation déjà utilisée ou rattachement impossible. Actualisez la page." } }
  }
  return acceptInvitationImpl(formData, {
    findInvitation: async (token) => {
      const invitation = await prisma.invitation.findFirst({
        where: { token, status: "PENDING", expiresAt: { gt: new Date() } },
      })
      return invitation as AcceptableInvitation | null
    },
    findUserByEmail: async (email) => {
      const account = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          active: true,
          role: true,
          companyId: true,
          employeeProfiles: { select: { id: true, active: true, companyId: true } },
        },
      })
      return account ? { ...account, employeeProfile: account.employeeProfiles.find(p => p.companyId === account.companyId) ?? null } : null
    },
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
              role: invitation.role,
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
            data: { active: true, role },
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
