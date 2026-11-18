// Navigation du module Comptabilité, réduite à cinq onglets : Achats, Ventes, Devis, Banque, Plus.
// Les écrans experts (écritures, balance, TVA, FEC…) restent tous accessibles, regroupés sous « Plus ». Fonctions pures.

export interface AccountingTab { href: string; label: string }

export const PLUS_HREF = "/comptabilite/plus"

export const ACCOUNTING_TABS: readonly AccountingTab[] = [
  { href: "/comptabilite/fournisseurs", label: "Achats" },
  { href: "/factures", label: "Ventes" },
  { href: "/devis", label: "Devis" },
  { href: "/comptabilite/banque", label: "Banque" },
  { href: PLUS_HREF, label: "Plus" },
]

export interface PlusLink { href: string; label: string; hint: string }
export interface PlusSection { title: string; links: readonly PlusLink[] }

export const PLUS_SECTIONS: readonly PlusSection[] = [
  {
    title: "Espaces du dossier",
    links: [
      { href: "/comptabilite", label: "Vue d'ensemble", hint: "Exercice ouvert, écritures validées, intégrité des journaux" },
      { href: "/notes-de-frais", label: "Notes de frais", hint: "Dépenses avancées par les salariés" },
      { href: "/vehicules", label: "Véhicules", hint: "Carburant, péages et entretien" },
    ],
  },
  {
    title: "Tenue comptable",
    links: [
      { href: "/comptabilite/ecritures", label: "Écritures", hint: "Saisie et consultation des écritures" },
      { href: "/comptabilite/factures", label: "Écritures depuis les factures", hint: "Comptabiliser les factures de vente" },
      { href: "/comptabilite/plan", label: "Plan comptable", hint: "Comptes de la société" },
      { href: "/comptabilite/exercices", label: "Exercices", hint: "Ouverture et clôture" },
    ],
  },
  {
    title: "États et déclarations",
    links: [
      { href: "/comptabilite/tableau-de-bord", label: "Tableau de bord", hint: "Résultat et trésorerie" },
      { href: "/comptabilite/balance", label: "Balance", hint: "Soldes par compte, export CSV" },
      { href: "/comptabilite/grand-livre", label: "Grand livre", hint: "Détail des mouvements par compte" },
      { href: "/comptabilite/tva", label: "TVA", hint: "TVA collectée et déductible" },
      { href: "/comptabilite/fec", label: "Export FEC", hint: "Fichier des écritures comptables" },
    ],
  },
]

const under = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`)

/** Onglet actif : l'onglet dont la route contient la page ; tout autre écran du module appartient à « Plus ». */
export function activeAccountingTab(pathname: string): string | null {
  const direct = ACCOUNTING_TABS.find((t) => t.href !== PLUS_HREF && under(pathname, t.href))
  if (direct) return direct.href
  return under(pathname, "/comptabilite") ? PLUS_HREF : null
}
