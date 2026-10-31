# Navigation par catégories (Sidebar et menu mobile)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement, en revue indépendante (Codex). Non poussé, non déployé |
| **Base** | `origin/main` = `8f432cb` |
| **Branche** | `feat/sidebar-categories` |
| **Décision** | Visuel « sidebar par catégories » validé par Nizar le 31/10/2026 |
| **Périmètre** | Affichage seulement : aucun changement serveur, aucune dépendance, aucune migration |

## Principe

Le regroupement s'applique **après** la composition existante, inchangée dans `Sidebar.tsx` et `MobileNav.tsx` : `getNavItems(role)` puis les drapeaux serveur `withAccountingNavItem`, `withBillingNavItems`, `withSupplierIntakeNavItem`, `withWorksitePhotosNavItem`. Il ne crée aucune permission, ne rend visible aucun lien masqué et ne modifie ni href, ni libellé, ni icône, ni badge. La visibilité dans le menu n'est pas une autorisation : chaque page garde ses contrôles serveur.

Chaque entrée composée apparaît **exactement une fois** : dans une catégorie, dans le pied (« Mon profil ») ou, si son href n'est pas cartographié, dans « Autres ». Aucune catégorie vide n'est affichée.

## Cartographie (`src/lib/navigation/nav-categories.ts`)

| Catégorie | Href, dans l'ordre d'affichage |
|-----------|--------------------------------|
| Pilotage | `/dashboard`, `/rapports` |
| Chantiers & terrain | `/chantiers` (Chantiers, Mes chantiers), `/photos-engins`, `/vehicules`, `/logements` |
| Planning | `/planning`, `/planning/moi` (Mon planning), `/planning/calendrier`, `/planning/gantt`, `/planning/personnel` |
| Équipes & RH | `/employes`, `/equipes`, `/planning/equipe` (Mon équipe), `/absences`, `/mes-absences`, `/pointages`, `/pointage`, `/notes-de-frais`, `/mes-notes-de-frais` |
| Commercial | `/clients`, `/consultations`, `/devis`, `/articles` |
| Finance | `/factures`, `/comptabilite`, `/factures-fournisseurs` |
| Administration | `/super-admin/entreprises`, `/parametres` |
| Pied | `/profil` (Mon profil), avec l'identité et Déconnexion |
| Autres | tout href non cartographié (repli) |

## Comportement et accessibilité (`src/components/layout/NavCategories.tsx`)

- En-têtes de catégorie : `<button>` natifs (Entrée / Espace), `aria-expanded`, `aria-controls` vers la liste (`hidden` quand repliée), identifiants uniques par instance (`useId`).
- Lien actif : `aria-current="page"`, même règle d'activation qu'avant (`getActiveNavHref`, la plus spécifique).
- La catégorie active est ouverte dès le rendu, puis rouverte à **chaque navigation** (clé = pathname, donc aussi d'une page de détail à une autre sous le même parent) et quand la catégorie active change sur la même route. L'utilisateur peut replier et rouvrir librement ; un repli manuel est respecté tant que ni la route ni la catégorie active ne changent. État local uniquement : aucune persistance, rien en stockage navigateur.
- Menu mobile : mêmes catégories ; un clic sur un lien ferme le menu ; replier une catégorie ne le ferme pas. Tiroir fermé `inert` et `aria-hidden`. Ouvert : `role="dialog"`, `aria-modal`, focus sur « Fermer le menu », Tab et Maj+Tab confinés aux éléments réellement rendus (le piège ne bloque jamais Tab si le tiroir est masqué par le CSS), Échap, bouton Fermer et voile referment le menu et rendent le focus au bouton « Ouvrir le menu ».

## Tests

| Suite | Contenu |
|-------|---------|
| `tests/navigation/nav-categories.test.ts` | Partition sans perte ni doublon pour 5 rôles × 16 combinaisons de drapeaux, cartographie par rôle, drapeaux absents, Photos engins pour tous les rôles internes, repli « Autres », catégorie active sur routes imbriquées, réducteur d'ouverture |
| `tests/navigation/nav-categories.render.test.tsx` | Rendu Sidebar et MobileNav (doubles de `next/navigation` et `next-auth/react`) : ordre, état ouvert, listes contrôlées, lien actif unique, pied, liens masqués absents, tiroir fermé inert, identifiants distincts |
| Existants | `nav-config.test.ts`, `nav-worksite-photos.test.ts` inchangés et verts |

Le piège de focus et le passage de viewport sont vérifiés dans un navigateur réel (aucun DOM simulé n'est installé dans le dépôt).
