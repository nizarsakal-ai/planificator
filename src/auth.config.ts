import type { NextAuthConfig } from "next-auth"
import type { JWT } from "next-auth/jwt"
import type { Session } from "next-auth"

/**
 * Callbacks Edge-safe (pas de Prisma).
 * Le middleware (`NextAuth(authConfig).auth`) n’utilise que ce fichier :
 * sans jwt/session ici, `auth.user.role` reste undefined même si le JWT
 * et `/api/auth/session` (Node, auth.ts) exposent correctement le rôle.
 */
export async function edgeJwtCallback({
  token,
  user,
}: {
  token: JWT
  user?: { id?: string; role?: string; companyId?: string | null } | null
}): Promise<JWT> {
  if (user) {
    token.id = user.id as string
    token.role = user.role as JWT["role"]
    token.companyId = user.companyId ?? null
  }
  return token
}

export async function edgeSessionCallback({
  session,
  token,
}: {
  session: Session
  token: JWT
}): Promise<Session> {
  if (token) {
    session.user.id = token.id as string
    session.user.role = token.role as Session["user"]["role"]
    session.user.companyId = (token.companyId as string | null) ?? null
  }
  return session
}

export function authorizedCallback({
  auth,
  request: { nextUrl },
}: {
  auth: { user?: { role?: string } | null } | null
  request: { nextUrl: URL }
}): boolean | Response {
  const isLoggedIn = !!auth?.user
  const role = auth?.user?.role as string | undefined
  const pathname = nextUrl.pathname

  // ── Routes publiques ────────────────────────────────────────────────
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/inscription") ||
    pathname.startsWith("/invitation") ||
    pathname.startsWith("/reinitialiser") ||
    pathname.startsWith("/mot-de-passe-oublie")
  ) {
    if (isLoggedIn) {
      const destination =
        role === "SUPER_ADMIN"
          ? "/super-admin/entreprises"
          : role === "CLIENT"
            ? "/mes-chantiers"
            : "/dashboard"
      return Response.redirect(new URL(destination, nextUrl))
    }
    return true
  }

  // ── Routes Super Admin ──────────────────────────────────────────────
  if (pathname.startsWith("/super-admin")) {
    if (!isLoggedIn) return false
    return role === "SUPER_ADMIN"
  }

  // ── Portail client ──────────────────────────────────────────────────
  if (pathname.startsWith("/mes-chantiers")) {
    if (!isLoggedIn) return false
    return role === "CLIENT"
  }

  // ── Toutes les autres routes : connexion obligatoire ────────────────
  if (!isLoggedIn) return false

  // Empêcher les clients d'accéder au dashboard interne
  if (role === "CLIENT" && pathname.startsWith("/dashboard")) {
    return Response.redirect(new URL("/mes-chantiers", nextUrl))
  }

  return true
}

// Configuration Edge-compatible (sans import Prisma)
// Utilisée par le middleware — tourne dans le runtime Edge de Next.js
export const authConfig: NextAuthConfig = {
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    authorized: authorizedCallback,
    jwt: edgeJwtCallback,
    session: edgeSessionCallback,
  },
  providers: [], // Providers définis dans auth.ts (Node.js uniquement)
}
