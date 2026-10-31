/**
 * Lecture des destinataires des photos : autorité RELUE EN BASE avant toute lecture d'adresse (page détail).
 * Une session périmée (compte rétrogradé ou désactivé, entreprise désactivée) ne lit aucune adresse.
 * Les droits historiques des autres champs du chantier ne sont pas concernés.
 */
import type { PrismaClient } from "@prisma/client"

export async function canReadPhotoRecipients(
  db: Pick<PrismaClient, "user" | "company">,
  session: { user?: { id?: string | null; role?: string | null; companyId?: string | null } | null } | null,
): Promise<boolean> {
  const user = session?.user
  if (!user?.id || user.role !== "SUPER_ADMIN" || !user.companyId) return false
  const [actor, company] = await Promise.all([
    db.user.findFirst({ where: { id: user.id }, select: { active: true, role: true } }),
    db.company.findFirst({ where: { id: user.companyId }, select: { active: true } }),
  ])
  return !!actor?.active && actor.role === "SUPER_ADMIN" && !!company?.active
}
