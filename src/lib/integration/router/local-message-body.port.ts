/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2C
 * Port local du corps de message pour `BODY_KEYWORD` (SPEC LOT-2 §12 ; plan I3).
 *
 * Ne lit qu'un corps DÉJÀ matérialisé localement. Interdits : fetch Gmail, second poll, worker de contenu,
 * résolution distante de `bodyRef`, téléchargement de pièce jointe.
 * V1 : une seule implémentation, `UnavailableLocalBodyPort` (toujours indisponible) ⇒ `BODY_KEYWORD` ne matche
 * jamais. Un port lisant un contenu stocké localement exigera un GO séparé (PII).
 */

export type LocalMessageBody = { available: false } | { available: true; text: string }

export interface LocalMessageBodyPort {
  read(input: { companyId: string; normalizedInboundId: string }): Promise<LocalMessageBody>
}

export class UnavailableLocalBodyPort implements LocalMessageBodyPort {
  async read(): Promise<LocalMessageBody> {
    return { available: false }
  }
}
