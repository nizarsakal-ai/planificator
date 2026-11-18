/**
 * Taille maximale d'un fichier ENVOYÉ au serveur (dépôt, lecture, transmission, reprise).
 * Vercel refuse tout corps de requête au-delà de 4,5 Mo (413, page non JSON) : 4 Mo laissent la marge de l'enveloppe
 * multipart et des champs du formulaire. La borne de stockage/lecture (MAX_PDF_BYTES, 10 Mo) reste distincte.
 * Module sans dépendance Node : importable côté client.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
export const MAX_UPLOAD_LABEL = "4 Mo"

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} Mo`
}

export function tooLargeMessage(name: string, bytes: number): string {
  return `« ${name} » est trop lourd (${formatMegabytes(bytes)}) : ${MAX_UPLOAD_LABEL} au maximum. Réduisez-le avant l’envoi `
    + "(sur Mac : Aperçu → Fichier → Exporter → Filtre Quartz « Réduire la taille du fichier », ou export en JPEG)."
}
