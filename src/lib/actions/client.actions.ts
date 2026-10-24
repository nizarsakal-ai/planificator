"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { Prisma } from "@prisma/client"
import { createClientSchema, updateClientSchema } from "@/lib/validations/client"
import { CLIENT_DELETE_ROLES } from "@/lib/clients/client-actions-view"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// Garde propre à deleteClient : ADMIN/SUPER_ADMIN uniquement.
// TEAM_LEADER — qui peut créer, modifier et désactiver des clients —
// n'a pas le droit de suppression définitive.
// requireAdmin (partagé) conserve TEAM_LEADER pour les autres actions.
async function requireDeleteAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!CLIENT_DELETE_ROLES.includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Créer un client ─────────────────────────────────────────────────────────

export async function createClient(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    name:    formData.get("name")    as string,
    email:   formData.get("email")   as string,
    phone:   formData.get("phone")   as string,
    address: formData.get("address") as string,
    notes:   formData.get("notes")   as string,
  }

  const parsed = createClientSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  await prisma.client.create({
    data: {
      name:      parsed.data.name,
      email:     parsed.data.email || null,
      phone:     parsed.data.phone || null,
      address:   parsed.data.address || null,
      notes:     parsed.data.notes || null,
      companyId: user.companyId!,
    },
  })

  revalidatePath("/clients")
  return { success: true }
}

// ─── Modifier un client ───────────────────────────────────────────────────────

export async function updateClient(clientId: string, formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    name:    formData.get("name")    as string,
    email:   formData.get("email")   as string,
    phone:   formData.get("phone")   as string,
    address: formData.get("address") as string,
    notes:   formData.get("notes")   as string,
  }

  const parsed = updateClientSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const client = await prisma.client.findFirst({
    where: { id: clientId, companyId: user.companyId! },
  })
  if (!client) return { error: "Client introuvable." }

  await prisma.client.update({
    where: { id: clientId },
    data: {
      name:    parsed.data.name,
      email:   parsed.data.email || null,
      phone:   parsed.data.phone || null,
      address: parsed.data.address || null,
      notes:   parsed.data.notes || null,
    },
  })

  revalidatePath("/clients")
  return { success: true }
}

// ─── Supprimer un client ──────────────────────────────────────────────────────
//
// Contrôles serveur :
//  - Rôle : ADMIN ou SUPER_ADMIN uniquement (TEAM_LEADER refusé via requireDeleteAdmin)
//  - companyId : garde explicite dans requireDeleteAdmin — throw si null
//  - Appartenance : lecture bornée par id ET companyId → client étranger = introuvable
//  - Relations bloquantes : worksites, quotes, invoices, acquisitionPartners (FK RESTRICT)
//    et clientProfile (accès portail, FK CASCADE : sans ce contrôle le profil disparaîtrait
//    en silence et l'utilisateur CLIENT subsisterait orphelin). Client, profil et utilisateur
//    sont conservés ; la désactivation reste disponible.
//
// Concurrence — tout se passe dans UNE transaction, dans cet ordre :
//  1. SELECT … FROM clients WHERE id AND companyId FOR UPDATE
//     Verrou de ligne exclusif sur le client. Toute insertion référençant ce client
//     (client_profiles, worksites, quotes, invoices, acquisition_partners) prend en PostgreSQL
//     un verrou FOR KEY SHARE sur la ligne référencée, incompatible avec FOR UPDATE :
//       - un rattachement commencé AVANT nous bloque notre verrou jusqu'à son commit → l'étape 2
//         le voit et refuse ;
//       - un rattachement commencé APRÈS notre verrou attend notre commit → le client n'existe
//         plus, son INSERT échoue (FK) : aucun profil n'est créé puis cascadé en silence.
//     Une suppression ou un transfert concurrent du client est sérialisé de la même façon.
//  2. Lecture des relations sous le verrou (findFirst + _count + clientProfile).
//  3. DELETE borné par id ET companyId. Dans cette transaction, le verrou client est le premier et
//     le seul verrou de ligne pris explicitement, ce qui réduit les cycles avec les rivaux testés
//     (rattachement de profil ou de chantier, suppression, transfert : voir tests/clients/pg). Cela
//     ne démontre pas l'absence de deadlock avec tout autre chemin de l'application ; un deadlock
//     éventuel est levé par PostgreSQL (40P01) et propagé comme erreur générique.
//  Délais bornés :
//   - SET LOCAL lock_timeout = 4 s (PostgreSQL) : borne l'attente du verrou FOR UPDATE si un rival garde
//     la ligne ; PostgreSQL annule la requête (SQLSTATE 55P03), Prisma la remonte en P2010 → message
//     explicite, rien n'est modifié. Vérifié sur base jetable : le `timeout` Prisma seul ne borne PAS une
//     requête bloquée sur un verrou (la transaction reste en attente jusqu'au commit du rival).
//   - maxWait 2 s pour obtenir une connexion, timeout 5 s (> lock_timeout) pour la transaction (P2028,
//     même message, défense en profondeur).
//  Aucune migration : FOR UPDATE et lock_timeout s'appuient sur le schéma et la configuration existants ;
//  SET LOCAL ne vit que dans cette transaction.
//  P2003/P2025 sont conservés par défense en profondeur (ils ne devraient plus se produire).

const DELETE_TX_OPTIONS = { maxWait: 2_000, timeout: 5_000 } as const
/** Constante (pas de paramètre utilisateur) : attente maximale du verrou de ligne, strictement < timeout. */
const DELETE_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4000ms'"
const BUSY_MESSAGE = "Une autre opération est en cours sur ce client. Rien n'a été modifié, réessayez dans un instant."

/** PostgreSQL 55P03 (lock_not_available) remonté par Prisma en P2010, ou timeout Prisma P2028. */
function isLockWaitExceeded(e: Prisma.PrismaClientKnownRequestError): boolean {
  if (e.code === "P2028") return true
  const meta = e.meta as { code?: unknown } | undefined
  return e.code === "P2010" && meta?.code === "55P03"
}

/** Même forme que les autres actions clients : `result.error` ou `result.success` lisibles sans affinement. */
type DeleteOutcome = { success: true; error?: undefined } | { success?: undefined; error: string }

export async function deleteClient(clientId: string): Promise<DeleteOutcome> {
  const user = await requireDeleteAdmin()
  const companyId = user.companyId
  if (!companyId) throw new Error("Entreprise introuvable")

  let outcome: DeleteOutcome
  try {
    outcome = await prisma.$transaction(async (tx): Promise<DeleteOutcome> => {
      // 0. Attente de verrou bornée pour cette transaction seulement
      await tx.$executeRawUnsafe(DELETE_LOCK_TIMEOUT_SQL)
      // 1. Verrou exclusif sur la ligne client, borné par id ET companyId — un client étranger n'est pas trouvé
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "clients" WHERE "id" = ${clientId} AND "companyId" = ${companyId} FOR UPDATE`
      if (locked.length === 0) return { error: "Client introuvable." }

      // 2. Relations lues sous le verrou : aucun rattachement ne peut se glisser avant l'étape 3
      const client = await tx.client.findFirst({
        where: { id: clientId, companyId },
        include: {
          _count: {
            select: {
              worksites: true,
              quotes: true,
              invoices: true,
              acquisitionPartners: true,
            },
          },
          clientProfile: { select: { id: true } },
        },
      })
      if (!client) return { error: "Client introuvable." }

      const blockers: string[] = []
      if (client._count.worksites > 0)
        blockers.push(`${client._count.worksites} chantier${client._count.worksites > 1 ? "s" : ""}`)
      if (client._count.quotes > 0)
        blockers.push(`${client._count.quotes} devis`) // « devis » est invariant au pluriel
      if (client._count.invoices > 0)
        blockers.push(`${client._count.invoices} facture${client._count.invoices > 1 ? "s" : ""}`)
      if (client._count.acquisitionPartners > 0)
        blockers.push(`${client._count.acquisitionPartners} partenaire${client._count.acquisitionPartners > 1 ? "s" : ""}`)
      if (client.clientProfile)
        blockers.push("1 accès portail")

      if (blockers.length > 0) {
        return {
          error: `Impossible de supprimer : ${blockers.join(", ")} lié${blockers.length > 1 ? "s" : ""} à ce client. Réaffectez ou supprimez d'abord ces éléments.`,
        }
      }

      // 3. Suppression sous le verrou, toujours bornée par id ET companyId
      await tx.client.delete({ where: { id: clientId, companyId } })
      return { success: true }
    }, DELETE_TX_OPTIONS)
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2003") {
        return {
          error: "Un rattachement concurrent empêche la suppression. Réaffectez ou supprimez les éléments liés puis réessayez.",
        }
      }
      if (e.code === "P2025") {
        return {
          error: "Ce client n'existe plus ou n'appartient plus à cette entreprise. Il a peut-être déjà été supprimé ou transféré.",
        }
      }
      if (isLockWaitExceeded(e)) {
        return { error: BUSY_MESSAGE }
      }
    }
    throw e // hors du bloc instanceof : toute autre erreur est propagée
  }

  if (outcome.error) return outcome

  revalidatePath("/clients")
  return { success: true }
}

export async function toggleClientActive(clientId: string, active: boolean) {
  const user = await requireAdmin()

  const client = await prisma.client.findFirst({
    where: { id: clientId, companyId: user.companyId! },
  })
  if (!client) return { error: "Client introuvable." }

  await prisma.client.update({
    where: { id: clientId },
    data: { active },
  })

  revalidatePath("/clients")
  return { success: true }
}
