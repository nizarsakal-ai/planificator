import type { Prisma } from "@prisma/client"

/**
 * Paramètres de pool Prisma adaptés aux fonctions serverless (Vercel + Neon).
 *
 * Une instance Vercel inactive est gelée : le contrôle de santé du pool (toutes les 15 s) ne tourne pas, et les
 * connexions que le serveur ferme pendant ce temps restent dans le pool. Chaque requête suivante qui en reçoit une
 * échoue en P1017 (« Server has closed the connection »), une fois par connexion morte. Un délai d'inactivité court
 * fait jeter ces connexions au moment de l'emprunt, avant toute requête. Les délais de connexion couvrent le réveil
 * d'une base Neon suspendue (défauts Prisma : 5 s et 10 s).
 *
 * Une valeur déjà présente dans DATABASE_URL est conservée : la configuration d'environnement reste prioritaire.
 */
export const SERVERLESS_POOL_DEFAULTS: Readonly<Record<string, string>> = {
  max_idle_connection_lifetime: "10",
  connect_timeout: "15",
  pool_timeout: "20",
}

export function withServerlessPoolDefaults(url: string | undefined): string | undefined {
  if (!url) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // URL non analysable : Prisma signalera l'erreur habituelle, sans que ce module en réécrive le contenu.
    return url
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return url
  for (const [key, value] of Object.entries(SERVERLESS_POOL_DEFAULTS)) {
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value)
  }
  return parsed.toString()
}

/** Option `datasources` du constructeur PrismaClient ; vide si DATABASE_URL est absente (comportement Prisma inchangé). */
export function serverlessDatasources(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): Pick<Prisma.PrismaClientOptions, "datasources"> {
  const url = withServerlessPoolDefaults(databaseUrl)
  return url ? { datasources: { db: { url } } } : {}
}
