# Barre latérale premium, Apparence et connexion « bleu nuit éditorial »

| Champ | Valeur |
|-------|--------|
| **Statut** | Proposition locale, contrôlée au navigateur. Commit local `0600786` (première version) ; connexion variante C et barre latérale variante B par-dessus, non commitées. Rien de poussé ni déployé |
| **Base** | `origin/main` = `1cb7957` (le seul commit arrivé depuis, `f491b0b` / PR #121, ne touche que `vercel.json`) |
| **Branche** | `feat/sidebar-premium-appearance` (worktree `../planificator-sidebar-premium`, sans suivi distant) |
| **Décisions** | Accent bleu Planificator validé par Nizar (maquette « style Design & Code with AV »). Connexion : variante C « bleu nuit éditorial » choisie par Nizar parmi trois maquettes |
| **Périmètre** | Affichage seulement : aucun changement serveur, de route, d'autorisation, de schéma ni de dépendance |

## Barre latérale et menu mobile (variante B « verre givré », choisie par Nizar)

- Variante B retenue par Nizar (capture renvoyée avec « dans ce style », 3 nov. 2026). Carte flottante translucide (`bg-white/55`, flou d'arrière-plan, bord blanc, coins de 28 px) posée sur un fond de page dégradé doux (bleu, violet, ciel) : seul changement hors barre latérale, une classe de fond dans `src/app/(dashboard)/layout.tsx`. Tiroir mobile dans le même style, plus opaque (`bg-white/[0.94]`) car posé sur le voile sombre ; cibles de 44 px.
- Catégories : ouverte = titre de section en petites capitales ; repliée = ligne avec icône et nombre de liens ; la catégorie qui contient la page active reste teintée en bleu quand elle est repliée. Lien actif : pastille blanche avec ombre bleutée, icône dans une tuile dégradée bleu Planificator (`#3b6cf6 → #1d4ed8`), chevron. Liens inactifs d'une catégorie sans icône, alignés sous le libellé actif (`quietIcon`).
- Pied commun `NavFooter` (Sidebar et MobileNav) : « Mon profil » (même lien, même libellé), sélecteur **Apparence**, puis carte d'identité avec Déconnexion.
- Inchangés : composition des liens par rôle et drapeaux serveur (`getNavItems` puis `with…NavItem`), regroupement par catégories, lien actif unique (`getActiveNavHref`), `aria-expanded` / `aria-controls`, `aria-current`, piège de focus, Échap, retour du focus. « Documents RH » n'apparaît que si le serveur le rend visible (test ajouté). La visibilité dans le menu n'est pas une autorisation.
- Piège de focus corrigé pour le groupe radio : un seul arrêt de tabulation (bouton coché), comme le navigateur. Sans ce correctif, Tab depuis « Clair » sortait du tiroir.

## Apparence (Clair / Sombre / Système)

- Contrôle segmenté à curseur glissant, fait de boutons radio natifs (flèches du clavier, libellés « Clair », « Sombre », « Système »), dans le pied des deux menus, synchronisés entre eux et entre onglets. Le curseur ne glisse qu'après un choix de l'utilisateur (pas de déplacement visible au chargement) ; mouvement coupé si `prefers-reduced-motion`.
- Préférence **par utilisateur, sur l'appareil** : `localStorage["planificator:appearance:<id>"]`. Défaut : suivre l'appareil. Aucune migration, aucune donnée serveur.
- Script inline dans `<head>` (`appearanceBootScript`) : pose `<html data-appearance="light|dark">` avant le premier rendu (pas de flash). Identifiant sérialisé en JSON, `<` échappé ; erreurs de stockage ignorées.
- **Le sombre ne s'applique qu'aux surfaces qualifiées** marquées `data-appearance-scope` : barre latérale, tiroir mobile, moitié claire de la page de connexion. Le contenu des pages reste clair.
  - Raison : une recoloration globale a été essayée puis retirée. Sur `/planning`, la case « aujourd'hui » (`bg-blue-50`) restait claire avec un texte devenu clair, donc illisible (capture 11). Il y a 187 pastilles `bg-*-50` et des couleurs fixes (`text-[#0f3460]`, 73) à reprendre page par page.
  - Mécanique : l'échelle `slate` de Tailwind passe par des variables CSS (valeurs claires identiques à la palette d'origine, donc aucun changement visuel en clair) ; elles ne s'inversent que dans `[data-appearance="dark"] [data-appearance-scope]`. La variante `dark:` de Tailwind cible la même zone.
- **Lot 2 (à faire, non annoncé comme terminé)** : sombre de toute l'application, écran par écran, avec captures (pastilles `bg-*-50`, bleu marine fixe, pages sensibles : planning, factures et devis, comptabilité, documents RH, paramètres).

## Connexion « bleu nuit éditorial » (variante C choisie par Nizar)

- Remplace la version « deux tons » avec personnages, que Nizar a jugée « pas belle ». Variante C retenue parmi trois maquettes (A rail + panneau, B verre givré, C bleu nuit éditorial) : Nizar a renvoyé sa capture le 3 nov. 2026.
- Fond bleu nuit `#0f3460 → #0a2447` (identique en clair et en sombre) : marque, « Chantiers & équipes », titre « Chaque équipe, *au bon endroit,* au bon moment. » (Instrument Serif), grille de semaine 7 × 6 décorative (`aria-hidden`, sans élément interactif, masquée sur mobile). Aucune animation.
- Carte claire du formulaire : seule surface qui suit Apparence (`data-appearance-scope`) ; en sombre, surface `--surface`, champs sombres, bouton `blue-600`.
- `LoginForm` : **logique inchangée** (même schéma zod, `signIn("credentials", { redirect: false })`, mêmes messages, redirection `/`). Seul ajout d'interface : `passwordAside`, qui place « Mot de passe oublié ? » sous le mot de passe, avant le bouton. Les rappels vers l'ancienne illustration et `LoginCrew` sont supprimés.
- Bouton « Afficher / Masquer » atteignable au clavier, `aria-label`, `aria-pressed`, `aria-controls`. Erreurs reliées par `aria-describedby`, `aria-invalid`, `role="alert"` pour l'erreur serveur.

## Contrôles effectués (local, base Postgres Docker et comptes du seed)

| Contrôle | Résultat |
|----------|----------|
| Captures bureau 1200 × 760 et mobile 375 × 812, clair et sombre | Barre latérale, tiroir, connexion (dossier de notes partagé, `captures-sidebar-connexion/` ; connexion C : captures 12 à 15 ; barre latérale B : 16 à 19 ; bureau 1280 × 800) |
| Contraste menu B, clair | ≥ 6,95:1 sur le verre (titres de section et options Apparence passés de 4,37 à 6,95:1 en `slate-600`) ; lien actif 17,85:1 |
| Contraste menu B, sombre | ≈ 5,5:1 pour les liens inactifs, titres et options ; lien actif 17,85:1 |
| Contraste connexion, clair / sombre | Clair : textes ≥ 4,76:1, texte indicatif 4,55:1 sur le fond réel du champ, bouton 12,5:1. Sombre : ≥ 5,17:1 |
| Clavier tiroir mobile | Focus initial « Fermer le menu », Tab depuis le bouton radio coché va à Déconnexion puis revient à « Fermer le menu », Échap ferme et rend le focus à « Ouvrir le menu » (revérifié en variante B) |
| Clavier connexion | Ordre : email, mot de passe, Afficher, Mot de passe oublié, Se connecter, Créer mon entreprise (testé) ; envoi vide : message, `aria-invalid`, focus sur l’email |
| Connexion fonctionnelle | Champs vides : messages zod ; mauvais mot de passe : « Email ou mot de passe incorrect. » ; bon mot de passe : redirection vers `/dashboard` |
| Débordement | Aucun défilement horizontal (375 px et 1200 px) ; formulaire mobile entièrement visible sans défilement |
| Stockage | Seule clé écrite : `planificator:appearance:<id>` ; rien en `sessionStorage` |

Non vérifié : Safari / iOS sur appareil réel ; lint (le dépôt n'a pas de configuration ESLint ; `next lint` propose d'en créer une, refusé).

## Tests et typecheck

- `npm run test:navigation` : 65 + 15 tests verts. Ajouts : `tests/navigation/appearance.test.ts` (préférence, clé par utilisateur, script anti-flash exécuté dans un contexte isolé, échappement), rendu Apparence et Documents RH dans `nav-categories.render.test.tsx`, `tests/auth/login-experience.render.test.tsx` (formulaire, ordre de « Mot de passe oublié ? », bouton Afficher, grille décorative, seule la carte suit Apparence, logique de connexion inchangée, aucun stockage). `nav-config.test.ts` : les contrôles de source suivent le pied déplacé dans `NavFooter`, sans être affaiblis.
- `npx tsc --noEmit` : **52 diagnostics avant et après, liste identique** (comparaison triée contre un worktree propre de `1cb7957`). Tous préexistants, dans des tests hors périmètre :

| Fichier | Diagnostics |
|---------|-------------|
| `tests/booking/booking-email-intent-diagnostics.test.ts` | 14 (TS2345 / TS2741 : `NODE_ENV` manquant dans un `ProcessEnv` de test) |
| `tests/acquisition/lot-3g-r1-legacy-auto-fence.test.ts` | 14 (TS7006, TS7022, TS2339) |
| `tests/acquisition/cancellation-followup-transactional.test.ts` | 12 (TS2322, TS2352) |
| `tests/acquisition/consultations-fix-001.test.ts` | 6 (TS2339 sur `never`) |
| `tests/acquisition/lot-3g-transactional-fence.test.ts` | 2 |
| `tests/booking/booking-scan-pending-gate.test.ts` | 1 (TS2345, `NODE_ENV`) |
| `tests/acquisition/plan-acq-012-4-fencing.test.ts` | 1 |
| `tests/acquisition/partner-registry-bootstrap.test.ts` | 1 |
| `tests/acquisition/partner-registry-bootstrap.integration.test.ts` | 1 |

Par code : TS2741 × 10, TS7006 × 10, TS2322 × 8, TS2339 × 8, TS2352 × 7, TS2345 × 6, TS7022 × 3.
