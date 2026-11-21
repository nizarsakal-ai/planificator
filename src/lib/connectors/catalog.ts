/**
 * Lot F Planificator V2 : catalogue FERMÉ des connecteurs externes — commerce, paiement, marketing, publicité, messagerie,
 * assistant conversationnel, agenda, e-mail et documents — (la base refuse toute autre clé ; dix entrées depuis la v4).
 *
 * Chaque entrée décrit ce qu'un connecteur réel importerait ; AUCUN adaptateur réel n'est livré (`realAdapter: false`
 * pour tous) : une connexion réelle exige une autorisation de connexion, des identifiants et une migration dédiée
 * (l'énumération ConnectorMode n'a pas de mode réel). Le catalogue ne contient aucun identifiant ni secret : la liste
 * `credentialsRequired` nomme seulement ce qu'il faudrait fournir le jour venu.
 */
export type ConnectorKey = "shopify" | "stripe" | "mailchimp" | "meta_ads" | "google_ads" | "slack" | "chatgpt" | "google_calendar" | "outlook" | "sharepoint"
export type ConnectorCategory = "COMMERCE" | "PAYMENT" | "MARKETING" | "ADVERTISING" | "MESSAGING" | "AI_ASSISTANT" | "CALENDAR" | "EMAIL" | "DOCUMENTS"

export interface ConnectorResource { key: string; label: string }
export interface ConnectorDefinition {
  key: ConnectorKey
  label: string
  category: ConnectorCategory
  description: string
  resources: readonly ConnectorResource[]
  credentialsRequired: readonly string[]
  realAdapter: false
}

export const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  COMMERCE: "Boutique en ligne", PAYMENT: "Paiement", MARKETING: "Courriel marketing", ADVERTISING: "Publicité", MESSAGING: "Messagerie d'équipe",
  AI_ASSISTANT: "Assistant conversationnel", CALENDAR: "Agenda", EMAIL: "Messagerie électronique", DOCUMENTS: "Documents",
}

export const CONNECTORS: readonly ConnectorDefinition[] = Object.freeze([
  { key: "shopify", label: "Shopify", category: "COMMERCE", description: "Commandes et clients d'une boutique en ligne.",
    resources: [{ key: "orders", label: "Commandes" }, { key: "customers", label: "Clients" }], credentialsRequired: ["Domaine de la boutique", "Jeton d'accès d'application"], realAdapter: false },
  { key: "stripe", label: "Stripe", category: "PAYMENT", description: "Paiements encaissés en ligne.",
    resources: [{ key: "payments", label: "Paiements" }], credentialsRequired: ["Clé d'API restreinte en lecture"], realAdapter: false },
  { key: "mailchimp", label: "Mailchimp", category: "MARKETING", description: "Contacts d'audience et consentements.",
    resources: [{ key: "contacts", label: "Contacts" }], credentialsRequired: ["Clé d'API", "Identifiant d'audience"], realAdapter: false },
  { key: "meta_ads", label: "Meta Ads", category: "ADVERTISING", description: "Statistiques quotidiennes de campagnes.",
    resources: [{ key: "campaign_stats", label: "Statistiques de campagnes" }], credentialsRequired: ["Compte publicitaire", "Jeton d'accès système"], realAdapter: false },
  { key: "google_ads", label: "Google Ads", category: "ADVERTISING", description: "Statistiques quotidiennes de campagnes.",
    resources: [{ key: "campaign_stats", label: "Statistiques de campagnes" }], credentialsRequired: ["Identifiant client", "Jeton développeur", "Autorisation OAuth"], realAdapter: false },
  { key: "slack", label: "Slack", category: "MESSAGING", description: "Canaux disponibles pour de futures notifications (aucun envoi dans ce lot).",
    resources: [{ key: "channels", label: "Canaux" }], credentialsRequired: ["Jeton de robot"], realAdapter: false },
  // v4 (demande de Nizar, 19/11/2026) : quatre connecteurs utiles à Planificator, simulés comme les six premiers.
  // ChatGPT : la simulation ne produit que des MÉTADONNÉES de conversations de démonstration (titre, date). Elle n'accède à
  // aucun espace ChatGPT ni à aucun historique utilisateur, et n'appelle aucun fournisseur d'IA. Le mode de connexion réel
  // reste À QUALIFIER (offre, accord et périmètre de données) : aucun accès à un historique ChatGPT par une API tierce n'est
  // promis ici.
  { key: "chatgpt", label: "ChatGPT", category: "AI_ASSISTANT", description: "Métadonnées de conversations de démonstration (titre, date)\u00a0; aucun historique utilisateur importé.",
    resources: [{ key: "conversations", label: "Conversations" }], credentialsRequired: ["Mode de connexion à qualifier, sans accès promis à un historique ChatGPT"], realAdapter: false },
  { key: "google_calendar", label: "Google Agenda", category: "CALENDAR", description: "Événements de planning (début et fin).",
    resources: [{ key: "events", label: "Événements" }], credentialsRequired: ["Autorisation OAuth", "Identifiant d'agenda"], realAdapter: false },
  { key: "outlook", label: "Microsoft Outlook", category: "EMAIL", description: "Métadonnées d'e-mails de consultation (objet, expéditeur, date)\u00a0; aucun envoi.",
    resources: [{ key: "messages", label: "Messages" }], credentialsRequired: ["Autorisation OAuth Microsoft", "Boîte aux lettres"], realAdapter: false },
  { key: "sharepoint", label: "Microsoft SharePoint", category: "DOCUMENTS", description: "Métadonnées de documents de chantier (nom, type)\u00a0; aucun fichier ni téléchargement.",
    resources: [{ key: "documents", label: "Documents" }], credentialsRequired: ["Autorisation OAuth Microsoft", "Site et bibliothèque"], realAdapter: false },
] as const satisfies readonly ConnectorDefinition[])

export const CONNECTOR_KEYS: readonly ConnectorKey[] = CONNECTORS.map((c) => c.key)
export const isConnectorKey = (v: string): v is ConnectorKey => (CONNECTOR_KEYS as readonly string[]).includes(v)
export const connectorByKey = (k: ConnectorKey): ConnectorDefinition => CONNECTORS.find((c) => c.key === k)!
