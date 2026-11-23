/**
 * Lot D Planificator V2 : recherche globale — règles PURES.
 *
 * Droits : la recherche n'est ouverte qu'aux rôles ADMIN et SUPER_ADMIN de la société de session, et chaque groupe
 * n'apparaît que si la page vers laquelle il mène est elle-même accessible (drapeau du module) : la recherche ne
 * révèle jamais ce que l'utilisateur ne pourrait pas déjà ouvrir. Les chefs d'équipe et salariés n'ont pas la
 * recherche (leurs droits par chantier affecté ne sont pas encore modélisés ici : réserve assumée).
 * Aucune donnée RH : pas de groupe « employés » (réconciliation 12/11, revue indépendante D).
 * Requête : 2 à 64 caractères utiles, espaces réduits, caractères de contrôle et jokers SQL (% _ \) retirés.
 */
export type SearchGroup = "worksites" | "clients" | "quotes" | "invoices" | "articles" | "equipment" | "reserves"
export const GROUP_ORDER: readonly SearchGroup[] = ["worksites", "clients", "quotes", "invoices", "articles", "equipment", "reserves"]
export const GROUP_LABEL: Record<SearchGroup, string> = {
  worksites: "Chantiers", clients: "Clients", quotes: "Devis", invoices: "Factures",
  articles: "Articles", equipment: "Matériel", reserves: "Réserves",
}
export const MIN_QUERY = 2
export const MAX_QUERY = 64
export const PER_GROUP = 5

export interface SearchFlags { billing: boolean; equipment: boolean; reserves: boolean }

/** Normalise la saisie ; null si elle est trop courte après nettoyage (aucune requête n'est alors faite). */
export function normalizeQuery(raw: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const q = (raw ?? "").slice(0, 200).replace(/[\u0000-\u001f\u007f%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY).trim()
  return q.length >= MIN_QUERY ? q : null
}

/** Groupes autorisés pour un rôle et des drapeaux ; vide pour tout rôle autre qu'ADMIN et SUPER_ADMIN. */
export function allowedGroups(role: string | null | undefined, flags: SearchFlags): SearchGroup[] {
  if (role !== "ADMIN" && role !== "SUPER_ADMIN") return []
  return GROUP_ORDER.filter((g) => {
    if (g === "quotes" || g === "invoices") return flags.billing
    if (g === "equipment") return flags.equipment
    if (g === "reserves") return flags.reserves
    return true
  })
}

export interface SearchHit { group: SearchGroup; id: string; title: string; subtitle: string | null; href: string }

/** Lien de destination de chaque résultat (identifiant contrôlé ; jamais de donnée saisie dans le chemin). */
export function hrefFor(group: SearchGroup, id: string, extra?: { worksiteId?: string }): string {
  const safe = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : ""
  switch (group) {
    case "worksites": return `/chantiers/${safe}`
    case "clients": return "/clients"
    case "quotes": return `/devis/${safe}`
    case "invoices": return `/factures/${safe}`
    case "articles": return "/articles"
    case "equipment": return `/materiel/${safe}`
    case "reserves": return extra?.worksiteId && /^[A-Za-z0-9_-]{1,64}$/.test(extra.worksiteId) ? `/reserves/${extra.worksiteId}` : "/reserves"
  }
}
