/**
 * Catalogue de matériel événementiel proposé en menu déroulant à la création d'un équipement.
 * Chaque entrée pré-remplit la désignation et la catégorie (toujours modifiables) ; « Autre » laisse la saisie libre.
 */
export type CatalogItem = { name: string; category: string }

export const EVENT_CATALOG: { group: string; items: CatalogItem[] }[] = [
  { group: "Tentes et structures", items: [
    { name: "Tente pliante 3x3 m", category: "Tente" },
    { name: "Tente pliante 3x4,5 m", category: "Tente" },
    { name: "Tente pliante 3x6 m", category: "Tente" },
    { name: "Barnum 4x8 m", category: "Tente" },
    { name: "Chapiteau 5x10 m", category: "Tente" },
    { name: "Parois latérales de tente", category: "Tente" },
    { name: "Poids de lestage (jeu de 4)", category: "Tente" },
  ] },
  { group: "Animation", items: [
    { name: "Photobooth 360°", category: "Photobooth" },
    { name: "Photobooth", category: "Photobooth" },
    { name: "Borne selfie miroir", category: "Photobooth" },
    { name: "Prestation vidéo", category: "Prestation" },
    { name: "Prestation photo", category: "Prestation" },
    { name: "Machine à fumée", category: "Animation" },
    { name: "Machine à bulles", category: "Animation" },
  ] },
  { group: "Textile personnalisé", items: [
    { name: "Tee-shirt floqué", category: "Textile floqué" },
    { name: "Pull floqué", category: "Textile floqué" },
    { name: "Sweat à capuche floqué", category: "Textile floqué" },
    { name: "Casquette brodée", category: "Textile floqué" },
    { name: "Tablier floqué", category: "Textile floqué" },
  ] },
  { group: "Mobilier", items: [
    { name: "Table pliante", category: "Mobilier" },
    { name: "Table ronde (8-10 pers.)", category: "Mobilier" },
    { name: "Mange-debout", category: "Mobilier" },
    { name: "Housse de mange-debout", category: "Mobilier" },
    { name: "Chaise pliante", category: "Mobilier" },
    { name: "Chaise Napoléon", category: "Mobilier" },
    { name: "Tabouret haut", category: "Mobilier" },
    { name: "Comptoir / bar d'accueil", category: "Mobilier" },
    { name: "Salon lounge (canapé, fauteuils)", category: "Mobilier" },
    { name: "Nappe", category: "Mobilier" },
  ] },
  { group: "Sol et décoration", items: [
    { name: "Moquette événementielle (m²)", category: "Sol" },
    { name: "Plancher / parquet", category: "Sol" },
    { name: "Tapis rouge", category: "Sol" },
    { name: "Arche décorative", category: "Décoration" },
    { name: "Mur végétal", category: "Décoration" },
    { name: "Potelets et cordons", category: "Décoration" },
  ] },
  { group: "Son, vidéo et lumière", items: [
    { name: "Sonorisation (enceintes + table de mixage)", category: "Son" },
    { name: "Micro sans fil", category: "Son" },
    { name: "Écran / téléviseur", category: "Vidéo" },
    { name: "Vidéoprojecteur + écran", category: "Vidéo" },
    { name: "Mur LED", category: "Vidéo" },
    { name: "Jeu de lumières (projecteurs, lyres)", category: "Lumière" },
    { name: "Guirlande guinguette", category: "Lumière" },
  ] },
  { group: "Scène et logistique", items: [
    { name: "Scène / praticable", category: "Scène" },
    { name: "Pupitre", category: "Scène" },
    { name: "Groupe électrogène", category: "Énergie" },
    { name: "Rallonge et multiprise", category: "Énergie" },
    { name: "Chauffage d'extérieur", category: "Confort" },
    { name: "Brumisateur / ventilateur", category: "Confort" },
    { name: "Barrière de sécurité", category: "Sécurité" },
    { name: "Extincteur", category: "Sécurité" },
  ] },
  { group: "Réception", items: [
    { name: "Vaisselle (lot)", category: "Réception" },
    { name: "Verrerie (lot)", category: "Réception" },
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
  reference: eventArticleReference(it.name), designation: it.name.replace(/\s*\(m²\)$/, ""), unit: eventArticleUnit(it.name), group: g.group,
})))
