/**
 * PLAN-ACQ-MULTIMODAL — Empreinte source d'une extraction « pièces jointes seules ».
 *
 * Contexte : `contentHashAtExtraction` = `AcquisitionMessageContent.contentHash`
 * quand le mail a un texte exploitable (inchangé). Quand le mail n'a PAS de texte
 * exploitable, une extraction MANUELLE (relance humaine) peut s'appuyer sur les
 * pièces jointes STORED ; l'empreinte persistée devient alors :
 *
 *   "att1:" + sha256( "att1\n" + contentHash|"-" + "\n" + lignes triées
 *                     "<id>|<sha256>|<storagePublicId>|<sizeBytes>" )
 *
 * Propriétés :
 * - déterministe (tri par id, aucun horodatage) ;
 * - change dès qu'une pièce est (re)stockée, remplacée ou qu'un contenu apparaît ;
 * - préfixe `att1:` ⇒ ne peut JAMAIS égaler un contentHash (hex sha256) : toute
 *   preuve AUTO (detection === extraction === source courante) échoue par
 *   construction ⇒ AUTO approve / convert / validation restent fail-closed et
 *   la conversion AUTO tombe en SOURCE_CONTENT_STALE / HUMAN_REVIEW_REQUIRED.
 */

import { createHash } from "node:crypto"

export const ATTACHMENTS_ONLY_FINGERPRINT_PREFIX = "att1:"

export type ExtractionSourceKind = "MESSAGE_CONTENT" | "ATTACHMENTS_ONLY"

export type FingerprintAttachmentRow = {
  id?: string | null
  filename: string
  sha256?: string | null
  storagePublicId: string | null
  sizeBytes: number
  status: string
}

export function isAttachmentsOnlyFingerprint(hash: string | null | undefined): boolean {
  return typeof hash === "string" && hash.startsWith(ATTACHMENTS_ONLY_FINGERPRINT_PREFIX)
}

/** Texte de mail exploitable (même règle que la barrière 005A historique). */
export function hasExploitableMessageText(
  content: { normalizedText: string } | null | undefined
): boolean {
  return Boolean(content && content.normalizedText.trim())
}

export function computeAttachmentsOnlyFingerprint(input: {
  contentHash: string | null | undefined
  attachments: FingerprintAttachmentRow[]
}): string {
  const lines = input.attachments
    .filter((a) => a.status === "STORED" && Boolean(a.storagePublicId?.trim()))
    .map((a) =>
      [
        (a.id ?? a.filename).trim(),
        (a.sha256 ?? "").trim(),
        (a.storagePublicId ?? "").trim(),
        String(Number.isFinite(a.sizeBytes) ? Math.floor(a.sizeBytes) : 0),
      ].join("|")
    )
    .sort()
  const payload = ["att1", input.contentHash?.trim() || "-", ...lines].join("\n")
  return `${ATTACHMENTS_ONLY_FINGERPRINT_PREFIX}${createHash("sha256").update(payload).digest("hex")}`
}
