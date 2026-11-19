// Lot G Planificator V2 : Document Studio. Désactivé par défaut : sans DOCUMENT_STUDIO_ENABLED="true", ni page, ni
// action, ni PDF (404). Les PDF existants (devis, factures, paie, rapports…) ne sont pas concernés et restent inchangés.
type Env = Record<string, string | undefined>
export const DOCUMENT_STUDIO_FLAG_NAME = "DOCUMENT_STUDIO_ENABLED"
export function isDocumentStudioEnabled(env: Env = process.env): boolean {
  return env[DOCUMENT_STUDIO_FLAG_NAME] === "true"
}
