"use server"

import crypto from "crypto"
import bcrypt from "bcryptjs"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { anonymizedEmail, deleteOwnAccountImpl, type AccountDeletionResult } from "@/lib/account/account-deletion.core"

// Lot 2b juridique : « Supprimer mon compte » depuis le profil (voir account-deletion.core.ts pour les règles).

export async function deleteOwnAccount(formData: FormData): Promise<AccountDeletionResult> {
  return deleteOwnAccountImpl(
    {
      password: String(formData.get("password") ?? ""),
      confirmation: String(formData.get("confirmation") ?? ""),
    },
    {
      sessionUserId: async () => (await auth())?.user?.id ?? null,
      findAccount: async (userId) => {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true, role: true, password: true, companyId: true, active: true,
            company: { select: { id: true, name: true } },
            employeeProfiles: { select: { role: true, active: true, companyId: true, company: { select: { id: true, name: true } } } },
          },
        })
        if (!user || !user.active) return null
        const admin = new Map<string, string>()
        for (const p of user.employeeProfiles) if (p.active && p.role === "ADMIN") admin.set(p.company.id, p.company.name)
        // Administrateur « historique » sans fiche employé dans sa société principale.
        if (user.role === "ADMIN" && user.company && !user.employeeProfiles.some((p) => p.companyId === user.companyId)) {
          admin.set(user.company.id, user.company.name)
        }
        return {
          id: user.id,
          role: user.role,
          passwordHash: user.password,
          adminCompanies: [...admin].map(([id, name]) => ({ id, name })),
        }
      },
      verifyPassword: (plain, hash) => bcrypt.compare(plain, hash),
      countOtherAdmins: ({ companyId, userId }) =>
        prisma.user.count({
          where: {
            id: { not: userId },
            active: true,
            OR: [
              { employeeProfiles: { some: { companyId, role: "ADMIN", active: true } } },
              { companyId, role: "ADMIN", employeeProfiles: { none: { companyId } } },
            ],
          },
        }),
      anonymize: async (userId) => {
        // Mot de passe aléatoire jamais communiqué : la connexion devient impossible même si le compte était réactivé.
        const unusable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12)
        await prisma.$transaction(async (tx) => {
          const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { companyId: true } })
          await tx.user.update({
            where: { id: userId },
            data: { email: anonymizedEmail(userId), name: null, password: unusable, active: false, lastLoginAt: null },
          })
          // Fiches employé : désactivées ; coordonnées personnelles effacées. Nom, heures, paie et frais restent chez
          // l'employeur pour les durées légales annoncées dans la politique de confidentialité.
          await tx.employee.updateMany({ where: { userId }, data: { active: false, phone: null, avatarUrl: null } })
          await tx.clientProfile.deleteMany({ where: { userId } })
          await tx.notification.deleteMany({ where: { userId } })
          await tx.passwordReset.deleteMany({ where: { userId } })
          await tx.historyLog.create({
            data: {
              companyId: before.companyId,
              actorId: userId,
              action: "DELETED",
              entityType: "AccountDeletion",
              entityId: userId,
              detail: "Compte supprimé par son titulaire",
              newValue: { deletedAt: new Date().toISOString() },
            },
          })
        })
      },
    },
  )
}
