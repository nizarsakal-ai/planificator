/**
 * Catalogue de matériel événementiel proposé en menu déroulant à la création d'un équipement.
 * Chaque entrée pré-remplit la désignation et la catégorie (toujours modifiables) ; « Autre » laisse la saisie libre.
 */
/** `bulk` : article géré en quantité (stock seul, pas de fiche Matériel par unité). Sans `bulk` : suivi à l'unité dans Matériel. */
export type CatalogItem = { name: string; category: string; bulk?: true }

export const EVENT_CATALOG: { group: string; items: CatalogItem[] }[] = [
  { group: "Tentes et structures", items: [
    { name: "Tente pliante 3x3 m", category: "Tente" },
    { name: "Tente pliante 3x4,5 m", category: "Tente" },
    { name: "Tente pliante 3x6 m", category: "Tente" },
    { name: "Barnum 4x8 m", category: "Tente" },
    { name: "Chapiteau 5x10 m", category: "Tente" },
    { name: "Parois latérales de tente", category: "Tente", bulk: true },
    { name: "Poids de lestage (jeu de 4)", category: "Tente", bulk: true },
  ] },
  { group: "Animation", items: [
    { name: "Photobooth 360°", category: "Photobooth" },
    { name: "Photobooth", category: "Photobooth" },
    { name: "Borne selfie miroir", category: "Photobooth" },
    { name: "Prestation vidéo", category: "Prestation", bulk: true },
    { name: "Prestation photo", category: "Prestation", bulk: true },
    { name: "Machine à fumée", category: "Animation" },
    { name: "Machine à bulles", category: "Animation" },
  ] },
  { group: "Textile personnalisé", items: [
    { name: "Tee-shirt floqué", category: "Textile floqué", bulk: true },
    { name: "Pull floqué", category: "Textile floqué", bulk: true },
    { name: "Sweat à capuche floqué", category: "Textile floqué", bulk: true },
    { name: "Casquette brodée", category: "Textile floqué", bulk: true },
    { name: "Tablier floqué", category: "Textile floqué", bulk: true },
  ] },
  { group: "Mobilier", items: [
    { name: "Table pliante", category: "Mobilier", bulk: true },
    { name: "Table ronde (8-10 pers.)", category: "Mobilier", bulk: true },
    { name: "Mange-debout", category: "Mobilier", bulk: true },
    { name: "Housse de mange-debout", category: "Mobilier", bulk: true },
    { name: "Chaise pliante", category: "Mobilier", bulk: true },
    { name: "Chaise Napoléon", category: "Mobilier", bulk: true },
    { name: "Tabouret haut", category: "Mobilier", bulk: true },
    { name: "Comptoir / bar d'accueil", category: "Mobilier" },
    { name: "Salon lounge (canapé, fauteuils)", category: "Mobilier" },
    { name: "Nappe", category: "Mobilier", bulk: true },
  ] },
  { group: "Sol et décoration", items: [
    { name: "Moquette événementielle (m²)", category: "Sol", bulk: true },
    { name: "Plancher / parquet", category: "Sol", bulk: true },
    { name: "Tapis rouge", category: "Sol", bulk: true },
    { name: "Arche décorative", category: "Décoration" },
    { name: "Mur végétal", category: "Décoration" },
    { name: "Potelets et cordons", category: "Décoration", bulk: true },
  ] },
  { group: "Son, vidéo et lumière", items: [
    { name: "Sonorisation (enceintes + table de mixage)", category: "Son" },
    { name: "Micro sans fil", category: "Son", bulk: true },
    { name: "Écran / téléviseur", category: "Vidéo" },
    { name: "Vidéoprojecteur + écran", category: "Vidéo" },
    { name: "Mur LED", category: "Vidéo" },
    { name: "Jeu de lumières (projecteurs, lyres)", category: "Lumière" },
    { name: "Guirlande guinguette", category: "Lumière", bulk: true },
  ] },
  { group: "Scène et logistique", items: [
    { name: "Scène / praticable", category: "Scène", bulk: true },
    { name: "Pupitre", category: "Scène" },
    { name: "Groupe électrogène", category: "Énergie" },
    { name: "Rallonge et multiprise", category: "Énergie", bulk: true },
    { name: "Chauffage d'extérieur", category: "Confort" },
    { name: "Brumisateur / ventilateur", category: "Confort" },
    { name: "Barrière de sécurité", category: "Sécurité", bulk: true },
    { name: "Extincteur", category: "Sécurité", bulk: true },
  ] },
  { group: "Réception", items: [
    { name: "Vaisselle (lot)", category: "Réception", bulk: true },
    { name: "Verrerie (lot)", category: "Réception", bulk: true },
    { name: "Réfrigérateur / vitrine", category: "Réception" },
    { name: "Fontaine à eau", category: "Réception" },
  ] },
]

/** Préfixe des références d'articles de stock issus du catalogue événementiel. */
export const EVENT_REF_PREFIX = "EVT-"

/** Référence stable d'un article du catalogue (« Tente pliante 3x3 m » → « EVT-TENTE-PLIANTE-3X3-M »). */
export function eventArticleReference(name: string): string {
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return `${EVENT_REF_PREFIX}${slug}`.slice(0, 40).replace(/-+$/, "")
}

/** Unité de stock d'un article du catalogue : m² pour les sols au mètre carré, sinon l'unité. */
export const eventArticleUnit = (name: string) => (/\(m²\)/.test(name) ? "m²" : "u")

/** Articles à créer en stock : tout le catalogue, à plat, avec référence et unité. */
export const EVENT_STOCK_ARTICLES = EVENT_CATALOG.flatMap((g) => g.items.map((it) => ({
  reference: eventArticleReference(it.name), designation: it.name.replace(/\s*\(m²\)$/, ""), unit: eventArticleUnit(it.name), group: g.group, tracked: !it.bulk,
})))
