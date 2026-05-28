import type { NextAuthConfig } from "next-auth"

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
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user
      const role = auth?.user?.role as string | undefined
      const pathname = nextUrl.pathname

      // ── Routes publiques ────────────────────────────────────────────────
      if (pathname.startsWith("/login") || pathname.startsWith("/inscription")) {
        // Si déjà connecté, rediriger vers le bon dashboard
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
    },
  },
  providers: [], // Providers définis dans auth.ts (Node.js uniquement)
}
