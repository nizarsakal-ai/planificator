import { resolveCompanyAccess } from "@/lib/company-access"
import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { authConfig, edgeSessionCallback } from "@/auth.config"

/**
 * Motif d'un refus de connexion, journalisé côté serveur uniquement (jamais renvoyé au navigateur, qui reçoit toujours
 * le même message générique) : aucune adresse, aucun identifiant, aucune valeur saisie. Permet de distinguer un compte
 * jamais activé (invitation non acceptée, fiche RH à compléter) d'un mot de passe erroné.
 */
export type LoginRefusal = "INVALID_INPUT" | "USER_NOT_FOUND" | "USER_INACTIVE" | "BAD_PASSWORD" | "NO_ACTIVE_COMPANY_ACCESS"
export function logLoginRefusal(reason: LoginRefusal, log: (msg: string, data: { reason: LoginRefusal }) => void = console.warn) {
  log("[auth] LOGIN_REFUSED", { reason })
}

// Schéma de validation des credentials
const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
})

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials) {
        // Validation stricte des entrées
        const parsed = credentialsSchema.safeParse(credentials)
        if (!parsed.success) { logLoginRefusal("INVALID_INPUT"); return null }

        const { email, password } = parsed.data

        // Recherche de l'utilisateur avec son profil employé
        const user = await prisma.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          include: {
            company: { select: { active: true } },
            employeeProfiles: { include: { company: { select: { active: true } } } },
          },
        })

        // Vérifications de sécurité
        if (!user) { logLoginRefusal("USER_NOT_FOUND"); return null }
        if (!user.active) { logLoginRefusal("USER_INACTIVE"); return null }

        const isValid = await bcrypt.compare(password, user.password)
        if (!isValid) { logLoginRefusal("BAD_PASSWORD"); return null }

        // Mise à jour de la date de dernière connexion
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        })

        const access = resolveCompanyAccess(user, user.companyId)
        if (!access) { logLoginRefusal("NO_ACTIVE_COMPANY_ACCESS"); return null }
        const profile = user.employeeProfiles.find(p => p.companyId === access.companyId)
        const displayName = profile ? `${profile.firstName} ${profile.lastName}` : user.email

        return {
          id: user.id,
          email: user.email,
          name: displayName,
          image: profile?.avatarUrl ?? null,
          role: access.role as typeof user.role,
          companyId: access.companyId,
        }
      },
    }),
  ],
  // Merger avec authConfig : ne pas remplacer tout l'objet callbacks
  // (sinon `authorized` / jwt Edge seraient perdus côté config partagée).
  callbacks: {
    ...authConfig.callbacks,
    // Node uniquement : relit Prisma pour garder role/companyId à jour.
    // Le middleware Edge continue d'utiliser edgeJwtCallback (sans Prisma).
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id as string
        token.role = (user as { role: typeof token.role }).role
        token.companyId =
          (user as { companyId?: string | null }).companyId ?? null
      } else if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          include: { company: { select: { active: true } }, employeeProfiles: { include: { company: { select: { active: true } } } } },
        })
        if (!dbUser || !dbUser.active) return null
        const requested = trigger === "update" && typeof session?.user?.companyId === "string"
          ? session.user.companyId : token.companyId
        const access = resolveCompanyAccess(dbUser, requested)
        if (!access) return null
        token.role = access.role as typeof token.role
        token.companyId = access.companyId
      }
      return token
    },
    session: edgeSessionCallback,
  },
})
