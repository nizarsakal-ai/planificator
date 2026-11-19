/**
 * Lot F Planificator V2 : fournisseurs de l'assistant.
 *
 * Un seul fournisseur est utilisable : LOCAL_RULES, des règles déterministes exécutées sur le serveur, sans réseau et
 * sans transmission de données à un tiers. Le fournisseur d'IA externe est déclaré pour l'écran mais NON AUTORISÉ :
 * aucune implémentation, aucune variable d'environnement lue, aucun appel possible. Son branchement exigera une
 * autorisation de transfert de données, un choix de fournisseur et une revue dédiés. La base refuse d'ailleurs toute
 * proposition dont le fournisseur n'est pas LOCAL_RULES.
 */
export type ProviderId = "LOCAL_RULES" | "EXTERNAL_LLM"
export interface ProviderInfo { id: ProviderId; label: string; usable: boolean; network: boolean; note: string }

export const PROVIDERS: readonly ProviderInfo[] = Object.freeze([
  { id: "LOCAL_RULES", label: "Règles locales", usable: true, network: false, note: "Analyse déterministe des données de l'entreprise, sur le serveur, sans réseau." },
  { id: "EXTERNAL_LLM", label: "Modèle d'IA externe", usable: false, network: true, note: "Non autorisé : aucun fournisseur connecté, aucune donnée transmise." },
] as const satisfies readonly ProviderInfo[])

/** Le fournisseur actif est toujours LOCAL_RULES : rien ne permet d'en choisir un autre dans ce lot. */
export function activeProvider(): ProviderInfo & { id: "LOCAL_RULES" } {
  return PROVIDERS[0] as ProviderInfo & { id: "LOCAL_RULES" }
}
