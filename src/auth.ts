import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { authConfig, edgeSessionCallback } from "@/auth.config"

// Schéma de validation des credentials
const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const { handlers, auth, signIn, signOut } = NextAuth({
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
        if (!parsed.success) return null

        const { email, password } = parsed.data

        // Recherche de l'utilisateur avec son profil employé
        const user = await prisma.user.findUnique({
          where: { email },
          include: {
            employeeProfile: {
              select: {
                firstName: true,
                lastName: true,
                avatarUrl: true,
              },
            },
          },
        })

        // Vérifications de sécurité
        if (!user || !user.active) return null

        const isValid = await bcrypt.compare(password, user.password)
        if (!isValid) return null

        // Mise à jour de la date de dernière connexion
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        })

        // Construction du nom affiché
        const displayName = user.employeeProfile
          ? `${user.employeeProfile.firstName} ${user.employeeProfile.lastName}`
          : user.email

        return {
          id: user.id,
          email: user.email,
          name: displayName,
          image: user.employeeProfile?.avatarUrl ?? null,
          role: user.role,
          companyId: user.companyId,
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
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string
        token.role = (user as { role: typeof token.role }).role
        token.companyId =
          (user as { companyId?: string | null }).companyId ?? null
      } else if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { role: true, companyId: true, active: true },
        })
        if (!dbUser || !dbUser.active) return null
        token.role = dbUser.role
        token.companyId = dbUser.companyId
      }
      return token
    },
    session: edgeSessionCallback,
  },
})
