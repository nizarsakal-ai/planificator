import NextAuth from "next-auth"
import { authConfig } from "@/auth.config"

// Le middleware utilise la config Edge-compatible (sans Prisma)
// Il protège toutes les routes selon les règles définies dans authConfig.callbacks.authorized
export default NextAuth(authConfig).auth

export const config = {
  // Protéger toutes les routes sauf les assets statiques et les fichiers PWA.
  // sw.js / workbox / swe-worker / manifest.json doivent rester publics :
  // s'ils passent par l'auth, la mise à jour du service worker reçoit une
  // page de login (HTML) au lieu du script et échoue silencieusement —
  // les utilisateurs restent alors bloqués sur l'ancienne version en cache.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sw\\.js|swe-worker.*\\.js|workbox-.*\\.js|manifest\\.json|icons/|.*\\.png$|.*\\.jpg$|.*\\.svg$).*)",
  ],
}
