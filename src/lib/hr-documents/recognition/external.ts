/**
 * PLV2-DOC-RH-002 — secours de reconnaissance par un fournisseur externe : PRÉPARÉ, DÉSACTIVÉ.
 * Contrat seulement : aucun fournisseur n'est branché dans ce lot. Même avec HR_DOCUMENT_EXTERNAL_RECOGNITION_ENABLED=true,
 * `externalRecognizer` renvoie null tant qu'un adaptateur n'a pas été ajouté, revu et autorisé (contrat de traitement,
 * absence de conservation chez le fournisseur, registre RGPD). Une pièce d'identité ne quitte donc jamais le serveur.
 */
import type { DocumentKind } from "../domain"

export type ExternalRecognition = (input: { bytes: Uint8Array; kind: DocumentKind }) => Promise<{ text: string } | null>

export function externalRecognitionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.HR_DOCUMENT_EXTERNAL_RECOGNITION_ENABLED === "true"
}

export function externalRecognizer(env: NodeJS.ProcessEnv = process.env): ExternalRecognition | null {
  if (!externalRecognitionEnabled(env)) return null
  // Aucun adaptateur autorisé : le drapeau seul ne suffit pas à envoyer un document à l'extérieur.
  return null
}
