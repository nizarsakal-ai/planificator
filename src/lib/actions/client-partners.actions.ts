"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { CLIENT_DELETE_ROLES } from "@/lib/clients/client-actions-view"
import { acquisitionPartnerAdminService } from "@/lib/acquisition/admin/partner-admin.service"
import { isPartnerAdminError } from "@/lib/acquisition/admin/partner-admin.errors"

/**
 * Parcours « partenaire d'acquisition bloquant » lors de la suppression d'un client.
 *
 * Un AcquisitionPartner peut pointer un Client (FK composite tenant-safe, onDelete Restrict) :
 * c'est la cible déterministe des consultations de ce partenaire. Le registre partenaires n'a
 * aucune interface ; ce module expose le strict nécessaire pour retrouver les partenaires liés
 * à un client et les réaffecter (vers un autre client actif de la même entreprise) ou les
 * détacher, via le service d'administration existant (`setPartnerClient`, tenant-safe).
 *
 * Règles conservées : pas de suppression physique de partenaire (contrat du service), garde
 * `deleteClient` inchangée, droits identiques à la suppression de client (ADMIN / SUPER_ADMIN),
 * tout est borné par `companyId`. Les partenaires sont identifiés par id, jamais par nom.
 */

async function requirePartnerAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!CLIENT_DELETE_ROLES.includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return { ...session.user, companyId: session.user.companyId }
}

export type LinkedPartner = { id: string; name: string; code: string; active: boolean }
export type ReassignTarget = { id: string; name: string; email: string | null }

/** Partenaires de l'entreprise courante dont `clientId` = ce client (liste vide si client étranger). */
export async function listClientLinkedPartners(clientId: string): Promise<{ partners: LinkedPartner[] } | { error: string }> {
  const user = await requirePartnerAdmin()
  const client = await prisma.client.findFirst({ where: { id: clientId, companyId: user.companyId }, select: { id: true } })
  if (!client) return { error: "Client introuvable." }
  const partners = await prisma.acquisitionPartner.findMany({
    where: { clientId, companyId: user.companyId },
    select: { id: true, name: true, code: true, active: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  })
  return { partners }
}

/** Clients actifs de l'entreprise, autres que `clientId`, pouvant recevoir un partenaire. */
export async function listPartnerReassignTargets(clientId: string): Promise<{ targets: ReassignTarget[] } | { error: string }> {
  const user = await requirePartnerAdmin()
  const targets = await prisma.client.findMany({
    where: { companyId: user.companyId, active: true, NOT: { id: clientId } },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  })
  return { targets }
}

/**
 * Réaffecte un partenaire à `targetClientId` (client actif de la même entreprise) ou le détache (`null`).
 * Délègue au service d'administration : vérification tenant + client actif avant écriture, transaction.
 */
export async function reassignClientPartner(
  partnerId: string,
  targetClientId: string | null
): Promise<{ success: true; clientId: string | null } | { error: string }> {
  const user = await requirePartnerAdmin()
  try {
    const row = await acquisitionPartnerAdminService.setPartnerClient({
      companyId: user.companyId,
      partnerId,
      clientId: targetClientId,
    })
    revalidatePath("/clients")
    return { success: true, clientId: row.clientId }
  } catch (e) {
    if (isPartnerAdminError(e)) {
      switch (e.code) {
        case "PARTNER_NOT_FOUND":
          return { error: "Partenaire introuvable dans cette entreprise." }
        case "PARTNER_CLIENT_NOT_FOUND":
          return { error: "Client cible introuvable, inactif ou hors de cette entreprise." }
        default:
          return { error: "Réaffectation impossible. Réessayez." }
      }
    }
    throw e
  }
}
