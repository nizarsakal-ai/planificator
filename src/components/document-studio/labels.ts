// Lot G Planificator V2 : libellés du Document Studio (affichage seulement).
export const VERSION_STATUS_LABEL: Record<string, string> = { DRAFT: "brouillon", PUBLISHED: "publiée", RETIRED: "retirée" }
export const DOC_STATUS_LABEL: Record<string, string> = { PENDING_APPROVAL: "En attente de validation", ISSUED: "Émis", REJECTED: "Refusé" }
export const DOC_STATUS_CLASS: Record<string, string> = { PENDING_APPROVAL: "bg-amber-50 text-amber-700", ISSUED: "bg-green-50 text-green-700", REJECTED: "bg-red-50 text-red-600" }
export const FIELDS_HELP = "Champs : une ligne par champ « clé | libellé | TEXT, LONG_TEXT, DATE, AMOUNT ou NUMBER | obligatoire ou facultatif ». Dans le titre et le corps, citez-les par {{clé}}. Champs système toujours disponibles : {{entreprise}}, {{numero}}, {{date_document}}, {{client}}, {{chantier}}. Une ligne « # Titre » (dièse puis espace) crée un intertitre ; une ligne vide sépare les paragraphes."
