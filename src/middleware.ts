import NextAuth from "next-auth"
import { authConfig } from "@/auth.config"

// Le middleware utilise la config Edge-compatible (sans Prisma)
// Il protège toutes les routes selon les règles définies dans authConfig.callbacks.authorized
export default NextAuth(authConfig).auth

export const config = {
  // Protéger toutes les routes sauf les assets statiques
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.jpg$|.*\\.svg$).*)",
  ],
}
