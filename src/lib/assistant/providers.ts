/**
 * Lot F Planificator V2 : fournisseurs de l'assistant.
 *
 * Un seul fournisseur est utilisable : LOCAL_RULES, des règles déterministes exécutées sur le serveur, sans réseau et
 * sans transmission de données à un tiers. Le fournisseur d'IA externe est déclaré pour l'écran mais NON UTILISÉ PAR
 * CES PROPOSITIONS : aucune implémentation ici, aucune variable d'environnement lue, aucun appel possible. La base
 * refuse d'ailleurs toute proposition dont le fournisseur n'est pas LOCAL_RULES.
 * 24/11/2026 — libellé reformulé : l'ancien « Non autorisé : aucun fournisseur connecté, aucune donnée transmise » était
 * faux à l'échelle de l'application depuis le copilote IA-1 à IA-6 (« Assistant IA »), qui, lorsqu'il est activé, envoie
 * la conversation à un fournisseur d'IA externe. Le libellé décrit désormais le seul périmètre exact : les propositions de cette page.
 */
/** Exact quel que soit l'état du copilote : il ne parle que des propositions de cette page. */
export const EXTERNAL_LLM_NOTE = "Non utilisé pour ces propositions (calcul sur le serveur, sans réseau). L'« Assistant IA », s'il est activé, est un service distinct qui envoie la conversation à un fournisseur d'IA externe."

export type ProviderId = "LOCAL_RULES" | "EXTERNAL_LLM"
export interface ProviderInfo { id: ProviderId; label: string; usable: boolean; network: boolean; note: string }

export const PROVIDERS: readonly ProviderInfo[] = Object.freeze([
  { id: "LOCAL_RULES", label: "Règles locales", usable: true, network: false, note: "Analyse déterministe des données de l'entreprise, sur le serveur, sans réseau." },
  { id: "EXTERNAL_LLM", label: "Modèle d'IA externe", usable: false, network: true, note: EXTERNAL_LLM_NOTE },
] as const satisfies readonly ProviderInfo[])

/** Le fournisseur actif est toujours LOCAL_RULES : rien ne permet d'en choisir un autre dans ce lot. */
export function activeProvider(): ProviderInfo & { id: "LOCAL_RULES" } {
  return PROVIDERS[0] as ProviderInfo & { id: "LOCAL_RULES" }
}
