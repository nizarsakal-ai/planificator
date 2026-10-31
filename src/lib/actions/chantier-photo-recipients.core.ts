/**
 * Mise à jour d'un chantier AVEC sa liste de destinataires des photos — cœur transactionnel.
 * Contrat : docs/specs/worksite-photos/LOT-PHOTO-RECIPIENTS.md. AUCUN envoi automatique.
 *
 * Appelé seulement quand le formulaire FOURNIT la liste (cas `set`) ; sinon l'action garde son écriture historique.
 * Une transaction, AUCUN appel réseau dedans (le géocodage est fait avant, par l'action) :
 *   1. autorité relue sous verrous `FOR SHARE` (compte puis entreprise) : compte actif, rôle global SUPER_ADMIN, entreprise
 *      de session active — une révocation concurrente attend la fin de l'écriture ou la fait refuser ;
 *   2. chantier verrouillé `FOR UPDATE` dans l'entreprise de session (tenant), ce qui sérialise les éditions de la liste ;
 *   3. champs du chantier écrits, puis liste appliquée par DIFFÉRENCE sur l'adresse (insensible à la casse) : retraits,
 *      mises à jour (nom/fonction, casse, actif, ordre), ajouts — un destinataire conservé garde son identifiant ;
 *   4. marqueur `photoRecipientsConfiguredAt` posé UNE fois, par la base, au premier enregistrement (y compris `[]`) :
 *      « jamais configurée » ≠ « vidée volontairement » — l'adresse historique n'est plus jamais proposée ensuite ;
 *   5. audit `RECIPIENTS_SET` UNIQUEMENT si la liste change ou au premier enregistrement, compteurs seulement (jamais d'adresse).
 * `Worksite.clientContact` n'est jamais lu ni écrit ici.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import type { PhotoRecipientInput } from "@/lib/chantiers/photo-recipients"

export interface PhotoRecipientsUpdateInput {
  companyId: string
  actorUserId: string
  worksiteId: string
  /** Champs du formulaire déjà validés (même forme que l'écriture historique de `updateChantier`). */
  data: Omit<Prisma.WorksiteUncheckedUpdateManyInput, "clientContact" | "companyId" | "id">
  recipients: PhotoRecipientInput[]
}

export interface RecipientsDiff { added: number; removed: number; updated: number; firstConfiguration: boolean }

export type PhotoRecipientsUpdateResult =
  | { ok: true; changed: boolean; diff: RecipientsDiff }
  | { ok: false; code: "FORBIDDEN" | "WORKSITE_NOT_FOUND" }

class Refusal extends Error {
  constructor(readonly code: "FORBIDDEN" | "WORKSITE_NOT_FOUND") { super(code) }
}

const TX_OPTIONS = { isolationLevel: "ReadCommitted" as const, maxWait: 5_000, timeout: 10_000 }

export async function updateWorksiteWithPhotoRecipients(db: Pick<PrismaClient, "$transaction">, input: PhotoRecipientsUpdateInput): Promise<PhotoRecipientsUpdateResult> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.actorUserId} FOR SHARE`
      await tx.$queryRaw`SELECT "id" FROM "companies" WHERE "id" = ${input.companyId} FOR SHARE`
      const [actor, company] = await Promise.all([
        tx.user.findFirst({ where: { id: input.actorUserId }, select: { id: true, name: true, role: true, active: true } }),
        tx.company.findFirst({ where: { id: input.companyId }, select: { active: true } }),
      ])
      if (!actor?.active || actor.role !== "SUPER_ADMIN" || !company?.active) throw new Refusal("FORBIDDEN")

      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "worksites" WHERE "id" = ${input.worksiteId} AND "companyId" = ${input.companyId} FOR UPDATE`
      if (locked.length !== 1) throw new Refusal("WORKSITE_NOT_FOUND")

      const { count } = await tx.worksite.updateMany({ where: { id: input.worksiteId, companyId: input.companyId }, data: input.data })
      if (count !== 1) throw new Refusal("WORKSITE_NOT_FOUND")
      // Marqueur durable, posé une seule fois (0 ligne = déjà configuré) : horloge de la base.
      const firstConfiguration = (await tx.$executeRaw`UPDATE "worksites" SET "photoRecipientsConfiguredAt" = clock_timestamp()
        WHERE "id" = ${input.worksiteId} AND "companyId" = ${input.companyId} AND "photoRecipientsConfiguredAt" IS NULL`) === 1

      const scope = { worksiteId: input.worksiteId, companyId: input.companyId }
      const existing = await tx.worksitePhotoRecipient.findMany({ where: scope, select: { id: true, label: true, email: true, emailKey: true, active: true, position: true } })
      const wanted = input.recipients.map((r, position) => ({ ...r, emailKey: r.email.toLowerCase(), position }))
      const wantedKeys = new Set(wanted.map((r) => r.emailKey))
      const byKey = new Map(existing.map((r) => [r.emailKey, r]))

      // Ordre : retraits, puis mises à jour, puis ajouts (unicité par adresse et borne de 20 respectées à chaque instant).
      const removedIds = existing.filter((r) => !wantedKeys.has(r.emailKey)).map((r) => r.id)
      if (removedIds.length > 0) await tx.worksitePhotoRecipient.deleteMany({ where: { ...scope, id: { in: removedIds } } })
      let updated = 0, added = 0
      for (const r of wanted) {
        const current = byKey.get(r.emailKey)
        if (current) {
          if (current.label !== r.label || current.email !== r.email || current.active !== r.active || current.position !== r.position) {
            await tx.worksitePhotoRecipient.updateMany({
              where: { ...scope, id: current.id },
              data: { label: r.label, email: r.email, emailKey: r.emailKey, active: r.active, position: r.position, updatedById: actor.id },
            })
            updated++
          }
        } else {
          await tx.worksitePhotoRecipient.create({
            data: { ...scope, label: r.label, email: r.email, emailKey: r.emailKey, active: r.active, position: r.position, createdById: actor.id, updatedById: actor.id },
          })
          added++
        }
      }
      const diff = { added, removed: removedIds.length, updated, firstConfiguration }
      const changed = firstConfiguration || added + removedIds.length + updated > 0
      if (changed) {
        await tx.worksitePhotoEvent.create({
          data: {
            companyId: input.companyId, worksiteId: input.worksiteId, photoId: null, action: "RECIPIENTS_SET", actorKind: "USER",
            actorId: actor.id, actorNameSnapshot: actor.name?.trim() || "Super Admin", outcome: "DONE",
            detail: { total: wanted.length, active: wanted.filter((r) => r.active).length, ...diff },
          },
        })
      }
      return { ok: true as const, changed, diff }
    }, TX_OPTIONS)
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code }
    throw error
  }
}
