/**
 * Pont pièce jointe Acquisition → Document du chantier converti, protocole v2.
 *
 * Problème : une pièce jointe peut passer STORED pendant ou après la conversion
 * consultation → chantier. Sans coordination, elle peut ne jamais être copiée.
 *
 * Protocole (sans migration) : la ligne `worksite_import_drafts` sert de verrou partagé.
 * - Conversion : `lockDraftByIdForUpdate` AVANT de lire brouillon et pièces jointes.
 * - Téléchargement (AcquisitionAttachmentRepository.markStored) : dans UNE transaction,
 *   `lockDraftByMessageForUpdate`, transition vers STORED, puis `bridgeStoredAttachmentInTransaction`.
 *
 * Deux ordres possibles, tous deux sûrs :
 * - A. téléchargement d'abord : STORED commité, la conversion le voit et copie ;
 * - B. conversion d'abord : markStored attend son commit, voit CONVERTED, crée le Document
 *   atomiquement avec la transition STORED.
 *
 * Le pont n'est appelé QUE pour la transition gagnante vers STORED (jamais pour un
 * ALREADY_STORED) : un Document supprimé par un utilisateur n'est donc jamais recréé.
 * Si le pont échoue, la transaction est annulée (STORED annulé) et le retry existant reprend.
 */

import type { AcquisitionAttachmentCategory, Prisma } from "@prisma/client"
import { mapAttachmentCategoryToDocumentType } from "@/lib/acquisition/conversion/attachment-document-type"

export interface LockedDraft {
  id: string
  status: string
  createdWorksiteId: string | null
}

/** Verrou de la ligne brouillon, côté conversion (par id de brouillon, scopé tenant). */
export async function lockDraftByIdForUpdate(
  tx: Prisma.TransactionClient,
  input: { companyId: string; draftId: string }
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "worksite_import_drafts"
    WHERE "id" = ${input.draftId} AND "companyId" = ${input.companyId}
    FOR UPDATE`
}

/**
 * Verrou de la ligne brouillon, côté téléchargement (par message, scopé tenant).
 * Sous READ COMMITTED, après attente du verrou, la ligne retournée est la version committée
 * la plus récente (status CONVERTED si la conversion vient de committer).
 */
export async function lockDraftByMessageForUpdate(
  tx: Prisma.TransactionClient,
  input: { companyId: string; acquisitionMessageId: string }
): Promise<LockedDraft | null> {
  const rows = await tx.$queryRaw<LockedDraft[]>`
    SELECT "id", "status"::text AS "status", "createdWorksiteId"
    FROM "worksite_import_drafts"
    WHERE "acquisitionMessageId" = ${input.acquisitionMessageId}
      AND "companyId" = ${input.companyId}
    FOR UPDATE`
  return rows[0] ?? null
}

export interface BridgeableAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  category: AcquisitionAttachmentCategory
  storagePublicId: string
}

export type BridgeOutcome = "CREATED" | "ALREADY_BRIDGED" | "NO_CONVERTED_WORKSITE"

/**
 * Crée le Document du chantier converti pour une pièce jointe qui vient de passer STORED.
 * À appeler dans la même transaction que la transition, brouillon verrouillé.
 */
export async function bridgeStoredAttachmentInTransaction(
  tx: Prisma.TransactionClient,
  input: { companyId: string; draft: LockedDraft | null; attachment: BridgeableAttachment }
): Promise<BridgeOutcome> {
  const { draft, attachment } = input
  if (!draft || draft.status !== "CONVERTED" || !draft.createdWorksiteId) {
    return "NO_CONVERTED_WORKSITE"
  }

  // Tenant + existence (createdWorksiteId passe à NULL à la suppression du chantier : SetNull).
  const worksite = await tx.worksite.findFirst({
    where: { id: draft.createdWorksiteId, companyId: input.companyId },
    select: { id: true },
  })
  if (!worksite) return "NO_CONVERTED_WORKSITE"

  const result = await tx.document.createMany({
    data: [
      {
        worksiteId: worksite.id,
        name: attachment.filename,
        url: null,
        size: attachment.sizeBytes,
        mimeType: attachment.mimeType,
        type: mapAttachmentCategoryToDocumentType(attachment.category),
        storagePublicId: attachment.storagePublicId,
        sourceAcquisitionAttachmentId: attachment.id,
      },
    ],
    skipDuplicates: true,
  })

  return result.count === 1 ? "CREATED" : "ALREADY_BRIDGED"
}
