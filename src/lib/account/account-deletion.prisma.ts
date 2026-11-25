import crypto from "crypto"
import bcrypt from "bcryptjs"
import type { Prisma, PrismaClient } from "@prisma/client"
import { anonymizedEmail, type AccountDeletionDeps, type AccountForDeletion, type AnonymizeOutcome } from "@/lib/account/account-deletion.core"

// Lot 2b juridique : accès base de la suppression de compte, séparé de l'action serveur pour être testé sur une base
// PostgreSQL jetable avec les vraies requêtes (tests/legal/pg).

type Db = PrismaClient | Prisma.TransactionClient

class LastAdminAbort extends Error {
  constructor(readonly companies: string[]) { super("LAST_ADMIN") }
}

/** Autres administrateurs actifs d'une société : fiche employé ADMIN active, ou admin « historique » sans fiche. */
export function countOtherAdmins(db: Db, { companyId, userId }: { companyId: string; userId: string }) {
  return db.user.count({
    where: {
      id: { not: userId },
      active: true,
      OR: [
        { employeeProfiles: { some: { companyId, role: "ADMIN", active: true } } },
        { companyId, role: "ADMIN", employeeProfiles: { none: { companyId } } },
      ],
    },
  })
}

export async function findAccountForDeletion(db: Db, userId: string): Promise<AccountForDeletion | null> {
  const user = await db.user.findUnique({
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
  return { id: user.id, role: user.role, passwordHash: user.password, adminCompanies: [...admin].map(([id, name]) => ({ id, name })) }
}

export interface AnonymizeOptions {
  /** Tests uniquement : appelé après chaque écriture, pour prouver le retour arrière complet si une étape échoue. */
  onStep?: (step: string) => void
}

export async function anonymizeAccount(
  db: PrismaClient,
  userId: string,
  adminCompanies: { id: string; name: string }[],
  options: AnonymizeOptions = {},
): Promise<AnonymizeOutcome> {
  const step = options.onStep ?? (() => {})
  // Mot de passe aléatoire jamais communiqué : la connexion reste impossible même si le compte était réactivé.
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12)
  try {
    return await db.$transaction(async (tx) => {
      // Verrou des sociétés où ce compte est administrateur (ordre stable, pas d'interblocage) puis recompte : une
      // suppression concurrente du dernier autre administrateur attend ici et voit l'état validé.
      const ids = [...new Set(adminCompanies.map((c) => c.id))].sort()
      if (ids.length > 0) {
        await tx.$queryRaw`SELECT id FROM companies WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
        const blocking: string[] = []
        for (const c of adminCompanies) if ((await countOtherAdmins(tx, { companyId: c.id, userId })) === 0) blocking.push(c.name)
        if (blocking.length > 0) throw new LastAdminAbort(blocking)
      }

      const before = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { companyId: true, employeeProfiles: { select: { companyId: true, avatarUrl: true } } },
      })
      await tx.user.update({
        where: { id: userId },
        data: { email: anonymizedEmail(userId), name: null, password: unusable, active: false, lastLoginAt: null },
      })
      step("user")
      // Fiches employé : désactivées ; coordonnées personnelles effacées. Nom, heures, paie et frais restent chez
      // l'employeur pour les durées légales annoncées dans la politique de confidentialité.
      await tx.employee.updateMany({ where: { userId }, data: { active: false, phone: null, avatarUrl: null } })
      step("employees")
      await tx.clientProfile.deleteMany({ where: { userId } })
      await tx.notification.deleteMany({ where: { userId } })
      await tx.passwordReset.deleteMany({ where: { userId } })
      step("links")
      // Une trace par société concernée (fiches désactivées, ou société principale du compte).
      const companies = [...new Set([...before.employeeProfiles.map((p) => p.companyId), before.companyId].filter((c): c is string => !!c))]
      const deletedAt = new Date().toISOString()
      for (const companyId of companies.length > 0 ? companies : [null]) {
        await tx.historyLog.create({
          data: {
            companyId, actorId: userId, action: "DELETED", entityType: "AccountDeletion", entityId: userId,
            detail: "Compte supprimé par son titulaire", newValue: { deletedAt },
          },
        })
      }
      step("history")
      const avatarUrls = before.employeeProfiles.map((p) => p.avatarUrl).filter((u): u is string => !!u)
      return { ok: true as const, avatarUrls }
    })
  } catch (error) {
    if (error instanceof LastAdminAbort) return { ok: false, lastAdminCompanies: error.companies }
    throw error
  }
}

export function prismaAccountDeletionDeps(
  db: PrismaClient,
  sessionUserId: () => Promise<string | null>,
  deleteAvatars: (urls: string[]) => Promise<void>,
): AccountDeletionDeps {
  return {
    sessionUserId,
    findAccount: (userId) => findAccountForDeletion(db, userId),
    verifyPassword: (plain, hash) => bcrypt.compare(plain, hash),
    countOtherAdmins: (args) => countOtherAdmins(db, args),
    anonymize: (userId, companies) => anonymizeAccount(db, userId, companies),
    deleteAvatars,
  }
}
