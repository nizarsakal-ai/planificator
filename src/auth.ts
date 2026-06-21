import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { authConfig } from "@/auth.config"

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
  callbacks: {
    // Inclure role et companyId dans le JWT — relit la DB à chaque login
    async jwt({ token, user }) {
      if (user) {
        // Connexion fraîche : on stocke l'id, role et companyId
        token.id        = user.id as string
        token.role      = (user as any).role
        token.companyId = (user as any).companyId ?? null
      } else if (token.id) {
        // Session existante : on relit le rôle depuis la DB pour le garder à jour
        const dbUser = await prisma.user.findUnique({
          where:  { id: token.id as string },
          select: { role: true, companyId: true, active: true },
        })
        if (!dbUser || !dbUser.active) return null
        token.role      = dbUser.role
        token.companyId = dbUser.companyId
      }
      return token
    },
    // Exposer role et companyId dans la session côté client
    async session({ session, token }) {
      if (token) {
        session.user.id        = token.id as string
        session.user.role      = token.role as import("@prisma/client").Role
        session.user.companyId = token.companyId as string | null
      }
      return session
    },
    // Réutiliser la logique authorized de authConfig
    authorized: authConfig.callbacks!.authorized,
  },
})
