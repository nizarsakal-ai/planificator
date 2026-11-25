/**
 * Rattachement d'un compte CLIENT à SA fiche client, règle unique du portail client et de l'assistant IA.
 * 1. Lien explicite `ClientProfile` (compte → fiche) dans la société de la session : prioritaire.
 * 2. À défaut, repli historique par courriel : accepté seulement si UNE SEULE fiche de la société porte exactement ce
 *    courriel. Plusieurs fiches avec la même adresse ⇒ refus (rattachement ambigu), au lieu de choisir l'une d'elles au
 *    hasard comme le faisait `findFirst`. Revue Codex IA-6 du 24/11/2026.
 * La comparaison reste exacte (comme avant, sans nettoyage des espaces ni de la casse) : aucun compte n'est rattaché à une
 * fiche qu'il ne voyait pas déjà. Revue Codex de la PR #223.
 */
import type { PrismaClient } from "@prisma/client"

type Db = Pick<PrismaClient, "clientProfile" | "client">

export type ClientLink =
  | { ok: true; clientId: string; via: "PROFILE" | "EMAIL" }
  | { ok: false; reason: "NONE" | "AMBIGUOUS" }

export const CLIENT_LINK_MESSAGE: Record<"NONE" | "AMBIGUOUS", string> = {
  NONE: "Aucune fiche client n'est liée à votre compte : contactez votre interlocuteur.",
  AMBIGUOUS: "Votre adresse correspond à plusieurs fiches client : votre interlocuteur doit relier votre compte à la bonne fiche.",
}

export async function resolveClientLink(db: Db, user: { id: string; companyId: string | null | undefined; email?: string | null }): Promise<ClientLink> {
  if (!user.id || !user.companyId) return { ok: false, reason: "NONE" }
  const profile = await db.clientProfile.findFirst({
    where: { userId: user.id, client: { companyId: user.companyId } },
    select: { clientId: true },
  })
  if (profile) return { ok: true, clientId: profile.clientId, via: "PROFILE" }
  const email = user.email
  if (!email) return { ok: false, reason: "NONE" }
  const matches = await db.client.findMany({
    where: { companyId: user.companyId, email },
    select: { id: true },
    take: 2,
  })
  if (matches.length === 1) return { ok: true, clientId: matches[0].id, via: "EMAIL" }
  return { ok: false, reason: matches.length > 1 ? "AMBIGUOUS" : "NONE" }
}
