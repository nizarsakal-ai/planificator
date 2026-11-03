/**
 * Ombres bleues Planificator, partagées par la barre latérale et les composants d'interface (cartes, boutons). Ombres portées seulement, sans effet de relief (ni reflet intérieur, ni creux, ni soulèvement).
 * Écrites en entier pour que `cn` (tailwind-merge) les reconnaisse comme des ombres : une classe `shadow-*` passée
 * par une page les remplace au lieu de s'y ajouter.
 */

/** Pastille ou élément blanc posé sur une surface (lien actif du pied, curseur Apparence, bouton contour). */
export const SHADOW_RAISED = "shadow-[0_2px_4px_rgba(29,78,216,0.12),0_10px_20px_-10px_rgba(29,78,216,0.5)]"

/** Carte de contenu. */
export const SHADOW_CARD = "shadow-[0_2px_6px_-2px_rgba(29,78,216,0.14),0_18px_36px_-20px_rgba(29,78,216,0.45)]"

/** Bouton plein. */
export const SHADOW_BUTTON = "shadow-[0_2px_4px_rgba(15,40,120,0.2),0_10px_20px_-10px_rgba(29,78,216,0.7)]"

/** Curseur bleu foncé de la navigation. */
export const SHADOW_SLIDER = "shadow-[0_3px_6px_rgba(15,52,96,0.3),0_16px_28px_-12px_rgba(15,52,96,0.8)]"
