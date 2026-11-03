# Barre latérale premium, Apparence et connexion « deux tons »

| Champ | Valeur |
|-------|--------|
| **Statut** | Proposition locale, contrôlée au navigateur. Non commitée, non poussée, non déployée. Pas de validation visuelle finale de Nizar |
| **Base** | `origin/main` = `1cb7957` (le seul commit arrivé depuis, `f491b0b` / PR #121, ne touche que `vercel.json`) |
| **Branche** | `feat/sidebar-premium-appearance` (worktree `../planificator-sidebar-premium`, sans suivi distant) |
| **Décisions** | Accent bleu Planificator validé par Nizar (maquette « style Design & Code with AV »). Connexion : direction « deux tons raffiné », blanc / bleu discret (message de coordination, pas une validation finale) |
| **Périmètre** | Affichage seulement : aucun changement serveur, de route, d'autorisation, de schéma ni de dépendance |

## Barre latérale et menu mobile

- Carte flottante arrondie (bureau) et tiroir flottant (mobile, cibles de 44 px). Catégories avec icône, nombre de liens quand elles sont repliées, chevron. Lien actif en pastille dégradée bleue (`#2f62f0 → #1d4ed8`, texte blanc ≥ 5,1:1).
- Pied commun `NavFooter` (Sidebar et MobileNav) : « Mon profil » (même lien, même libellé), carte d'identité avec Déconnexion, sélecteur **Apparence**.
- Inchangés : composition des liens par rôle et drapeaux serveur (`getNavItems` puis `with…NavItem`), regroupement par catégories, lien actif unique (`getActiveNavHref`), `aria-expanded` / `aria-controls`, `aria-current`, piège de focus, Échap, retour du focus. « Documents RH » n'apparaît que si le serveur le rend visible (test ajouté). La visibilité dans le menu n'est pas une autorisation.
- Piège de focus corrigé pour le groupe radio : un seul arrêt de tabulation (bouton coché), comme le navigateur. Sans ce correctif, Tab depuis « Clair » sortait du tiroir.

## Apparence (Clair / Sombre / Système)

- Groupe de boutons radio natifs (flèches du clavier, libellés « Clair », « Sombre », « Système »), dans le pied des deux menus, synchronisés entre eux et entre onglets.
- Préférence **par utilisateur, sur l'appareil** : `localStorage["planificator:appearance:<id>"]`. Défaut : suivre l'appareil. Aucune migration, aucune donnée serveur.
- Script inline dans `<head>` (`appearanceBootScript`) : pose `<html data-appearance="light|dark">` avant le premier rendu (pas de flash). Identifiant sérialisé en JSON, `<` échappé ; erreurs de stockage ignorées.
- **Le sombre ne s'applique qu'aux surfaces qualifiées** marquées `data-appearance-scope` : barre latérale, tiroir mobile, moitié claire de la page de connexion. Le contenu des pages reste clair.
  - Raison : une recoloration globale a été essayée puis retirée. Sur `/planning`, la case « aujourd'hui » (`bg-blue-50`) restait claire avec un texte devenu clair, donc illisible (capture 11). Il y a 187 pastilles `bg-*-50` et des couleurs fixes (`text-[#0f3460]`, 73) à reprendre page par page.
  - Mécanique : l'échelle `slate` de Tailwind passe par des variables CSS (valeurs claires identiques à la palette d'origine, donc aucun changement visuel en clair) ; elles ne s'inversent que dans `[data-appearance="dark"] [data-appearance-scope]`. La variante `dark:` de Tailwind cible la même zone.
- **Lot 2 (à faire, non annoncé comme terminé)** : sombre de toute l'application, écran par écran, avec captures (pastilles `bg-*-50`, bleu marine fixe, pages sensibles : planning, factures et devis, comptabilité, documents RH, paramètres).

## Connexion « deux tons »

- Moitié claire : marque, « Bonjour, *ravi de vous revoir.* » (Instrument Serif pour l'italique), illustration décorative. Moitié bleu nuit `#0f3460` : carte en arche avec le formulaire.
- `LoginForm` : **logique inchangée** (même schéma zod, `signIn("credentials", { redirect: false })`, mêmes messages, redirection `/`). Nouveaux rappels optionnels `onFieldFocus(champ | null)` et `onPasswordVisibilityChange(booléen)` : jamais de valeur de champ (garde-fou testé).
- Bouton « Afficher / Masquer » : désormais atteignable au clavier (il était en `tabIndex={-1}` et sans libellé), `aria-label`, `aria-pressed`, `aria-controls`. Erreurs reliées par `aria-describedby`, `aria-invalid`, `role="alert"` pour l'erreur serveur.
- Illustration `LoginCrew` (repère, agenda, casque) : `aria-hidden`, aucun champ ni lien. Les yeux suivent la souris au repos (pointeur souris seulement, `requestAnimationFrame`), regardent le formulaire quand l'email a le focus, se ferment quand le mot de passe masqué a le focus et regardent ailleurs quand il est affiché. `prefers-reduced-motion` : pas de flottement (`motion-safe:` seulement) ni de suivi ; rendu serveur en mouvement réduit.

## Contrôles effectués (local, base Postgres Docker et comptes du seed)

| Contrôle | Résultat |
|----------|----------|
| Captures bureau 1200 × 760 et mobile 375 × 812, clair et sombre | Barre latérale, tiroir, connexion (dossier de notes partagé, `captures-sidebar-connexion/`) |
| Contraste menu, clair | ≥ 4,76:1 (pastille de nombre corrigée de 4,34 à 7:1) |
| Contraste menu, sombre | ≥ 5,1:1 |
| Contraste connexion, clair / sombre | Textes ≥ 4,76:1 ; texte indicatif des champs corrigé à 5,46:1 (mesuré sur le fond réel du champ) ; icônes décoratives 4,03:1 |
| Clavier tiroir mobile | Focus initial « Fermer le menu », Tab et Maj+Tab bouclent (y compris depuis le bouton radio coché), Échap ferme et rend le focus |
| Clavier connexion | Ordre : email, mot de passe, Afficher, Se connecter, Mot de passe oublié, Créer mon entreprise |
| Connexion fonctionnelle | Champs vides : messages zod ; mauvais mot de passe : « Email ou mot de passe incorrect. » ; bon mot de passe : redirection vers `/dashboard` |
| Débordement | Aucun défilement horizontal (375 px et 1200 px) ; formulaire mobile entièrement visible sans défilement |
| Stockage | Seule clé écrite : `planificator:appearance:<id>` ; rien en `sessionStorage` |

Non vérifié : `prefers-reduced-motion` en vrai navigateur (couvert par test de rendu et de source) ; Safari / iOS sur appareil réel ; lint (le dépôt n'a pas de configuration ESLint ; `next lint` propose d'en créer une, refusé).

## Tests et typecheck

- `npm run test:navigation` : 65 + 15 tests verts. Ajouts : `tests/navigation/appearance.test.ts` (préférence, clé par utilisateur, script anti-flash exécuté dans un contexte isolé, échappement), rendu Apparence et Documents RH dans `nav-categories.render.test.tsx`, `tests/auth/login-experience.render.test.tsx` (formulaire, bouton Afficher, illustration décorative, mouvement réduit, logique de connexion et absence de valeur transmise). `nav-config.test.ts` : les contrôles de source suivent le pied déplacé dans `NavFooter`, sans être affaiblis.
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
