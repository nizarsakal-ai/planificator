/**
 * Lot G2 Planificator V2 : modèles de départ du Document Studio. Données PURES (aucun accès serveur), proposées à la
 * création d'un modèle : le contenu est recopié dans le formulaire, puis librement modifié avant l'enregistrement du
 * brouillon. Rien n'est créé en base tant que le formulaire n'est pas envoyé.
 *
 * Ce sont des trames de mise en page et de champs, pas des documents juridiques validés : chaque entreprise relit et adapte
 * le texte avant de publier (mention affichée à l'écran).
 */
import type { Category, FieldDef } from "@/lib/document-studio/studio.format"

export interface Starter { id: string; label: string; description: string; name: string; category: Category; title: string; body: string; fields: FieldDef[]; requiresApproval: boolean }

export const STARTERS: readonly Starter[] = [
  {
    id: "contrat-prestation", label: "Contrat de prestation", description: "Parties, objet, durée, prix et conditions de règlement.",
    name: "Contrat de prestation", category: "CONTRACT", title: "Contrat de prestation {{numero}}", requiresApproval: true,
    body: [
      "# Entre les soussignés",
      "**{{entreprise}}**, {{entreprise_adresse}}, SIRET {{entreprise_siret}}, ci-après « le prestataire »,",
      "et **{{client}}**, {{client_adresse}}, ci-après « le client ».",
      "# Article 1 — Objet",
      "Le prestataire s'engage à réaliser pour le client la prestation suivante : {{objet}}.",
      "Lieu d'exécution : {{chantier}}, {{chantier_adresse}}.",
      "# Article 2 — Durée",
      "La prestation débute le {{date_debut}} et s'achève le {{date_fin}}.",
      "# Article 3 — Prix et règlement",
      "| Désignation | Montant HT |\n| {{objet}} | {{montant_ht}} |",
      "Conditions de règlement : {{conditions_reglement}}.",
      "# Article 4 — Dispositions particulières",
      "{{dispositions}}",
      "Fait le {{date_document}}, en deux exemplaires.",
    ].join("\n\n"),
    fields: [
      { key: "objet", label: "Objet de la prestation", type: "TEXT", required: true },
      { key: "date_debut", label: "Date de début", type: "DATE", required: true },
      { key: "date_fin", label: "Date de fin", type: "DATE", required: true },
      { key: "montant_ht", label: "Montant HT", type: "AMOUNT", required: true },
      { key: "conditions_reglement", label: "Conditions de règlement", type: "CHOICE", required: true, options: ["À réception de facture", "30 jours date de facture", "45 jours fin de mois", "Acompte de 30 % puis solde à la fin"] },
      { key: "dispositions", label: "Dispositions particulières", type: "LONG_TEXT", required: false, help: "Laissez vide s'il n'y en a pas : l'article reste alors sans texte." },
    ],
  },
  {
    id: "attestation-fin-travaux", label: "Attestation de fin de travaux", description: "Atteste la réalisation de travaux pour un client, sur un chantier.",
    name: "Attestation de fin de travaux", category: "CERTIFICATE", title: "Attestation de fin de travaux {{numero}}", requiresApproval: false,
    body: [
      "# Objet",
      "Nous soussignés, **{{entreprise}}**, attestons que les travaux de {{nature}} ont été réalisés pour {{client}} sur le chantier {{chantier}}, {{chantier_adresse}}.",
      "Les travaux se sont achevés le {{date_fin}}.",
      "# Observations",
      "{{observations}}",
      "Attestation établie le {{date_document}} pour servir et valoir ce que de droit.",
    ].join("\n\n"),
    fields: [
      { key: "nature", label: "Nature des travaux", type: "TEXT", required: true },
      { key: "date_fin", label: "Date de fin des travaux", type: "DATE", required: true },
      { key: "observations", label: "Observations", type: "LONG_TEXT", required: false },
    ],
  },
  {
    id: "proces-verbal-reception", label: "Procès-verbal de réception", description: "Réception avec ou sans réserves, liste des réserves.",
    name: "Procès-verbal de réception", category: "REPORT", title: "Procès-verbal de réception {{numero}}", requiresApproval: true,
    body: [
      "# Chantier",
      "- Chantier : {{chantier}}, {{chantier_adresse}}\n- Client : {{client}}\n- Entreprise : {{entreprise}}",
      "# Réception",
      "Après visite des ouvrages le {{date_visite}}, la réception est prononcée : **{{decision}}**.",
      "## Réserves",
      "{{reserves}}",
      "Les réserves éventuelles seront levées au plus tard le {{date_levee}}.",
      "# Signatures",
      "| Pour l'entreprise | Pour le client |\n| {{representant_entreprise}} | {{representant_client}} |",
    ].join("\n\n"),
    fields: [
      { key: "date_visite", label: "Date de la visite", type: "DATE", required: true },
      { key: "decision", label: "Décision", type: "CHOICE", required: true, options: ["sans réserve", "avec réserves", "refusée"] },
      { key: "reserves", label: "Réserves", type: "LONG_TEXT", required: false, help: "Une réserve par ligne." },
      { key: "date_levee", label: "Date limite de levée des réserves", type: "DATE", required: false },
      { key: "representant_entreprise", label: "Représentant de l'entreprise", type: "TEXT", required: true },
      { key: "representant_client", label: "Représentant du client", type: "TEXT", required: true },
    ],
  },
  {
    id: "compte-rendu-chantier", label: "Compte rendu de chantier", description: "Avancement, points abordés et actions à mener.",
    name: "Compte rendu de chantier", category: "REPORT", title: "Compte rendu de chantier — {{chantier}}", requiresApproval: false,
    body: [
      "# Réunion du {{date_reunion}}",
      "- Chantier : {{chantier}}\n- Client : {{client}}\n- Participants : {{participants}}",
      "# Avancement",
      "Avancement estimé : {{avancement}} %.",
      "{{points}}",
      "# Actions à mener",
      "{{actions}}",
      "Prochaine réunion : {{prochaine_reunion}}.",
    ].join("\n\n"),
    fields: [
      { key: "date_reunion", label: "Date de la réunion", type: "DATE", required: true },
      { key: "participants", label: "Participants", type: "TEXT", required: true },
      { key: "avancement", label: "Avancement (%)", type: "NUMBER", required: true },
      { key: "points", label: "Points abordés", type: "LONG_TEXT", required: true },
      { key: "actions", label: "Actions à mener", type: "LONG_TEXT", required: false },
      { key: "prochaine_reunion", label: "Prochaine réunion", type: "DATE", required: false },
    ],
  },
  {
    id: "courrier", label: "Courrier", description: "Lettre simple à un client : objet, texte libre, signataire.",
    name: "Courrier", category: "LETTER", title: "{{objet}}", requiresApproval: false,
    body: [
      "{{client}}\n{{client_adresse}}",
      "**Objet : {{objet}}**",
      "Madame, Monsieur,",
      "{{texte}}",
      "Nous vous prions d'agréer, Madame, Monsieur, l'expression de nos salutations distinguées.",
      "{{signataire}}\n{{entreprise}}",
    ].join("\n\n"),
    fields: [
      { key: "objet", label: "Objet du courrier", type: "TEXT", required: true },
      { key: "texte", label: "Texte du courrier", type: "LONG_TEXT", required: true },
      { key: "signataire", label: "Signataire", type: "TEXT", required: true },
    ],
  },
]

/** Modèle de départ demandé par l'adresse (`?depart=`) : une seule valeur texte de la liste fermée, sinon aucun. */
export function lireDepart(valeur: unknown): Starter | null {
  return typeof valeur === "string" ? STARTERS.find((s) => s.id === valeur) ?? null : null
}
