# Barre latérale premium, Apparence et connexion « bleu nuit éditorial »

| Champ | Valeur |
|-------|--------|
| **Statut** | Proposition locale, contrôlée au navigateur. Commit local `0600786` (première version) ; `3833218` (connexion C, barre latérale B) ; thème crème et bleu, curseur glissant et style étendu à toute l'application par-dessus, non commités. Rien de poussé ni déployé |
| **Base** | `origin/main` = `1cb7957` (le seul commit arrivé depuis, `f491b0b` / PR #121, ne touche que `vercel.json`) |
| **Branche** | `feat/sidebar-premium-appearance` (worktree `../planificator-sidebar-premium`, sans suivi distant) |
| **Décisions** | Accent bleu Planificator validé par Nizar (maquette « style Design & Code with AV »). Connexion : variante C « bleu nuit éditorial » choisie par Nizar parmi trois maquettes |
| **Périmètre** | Affichage seulement : aucun changement serveur, de route, d'autorisation, de schéma ni de dépendance |

## Barre latérale et menu mobile (variante B « verre givré », choisie par Nizar)

- Variante B retenue par Nizar (capture renvoyée avec « dans ce style », 3 nov. 2026). Carte flottante translucide (`bg-white/55`, flou d'arrière-plan, bord blanc, coins de 28 px) posée sur un fond de page dégradé doux (bleu, violet, ciel) : seul changement hors barre latérale, une classe de fond dans `src/app/(dashboard)/layout.tsx`. Tiroir mobile dans le même style, plus opaque (`bg-white/[0.94]`) car posé sur le voile sombre ; cibles de 44 px.
- Catégories : ouverte = titre de section en petites capitales ; repliée = ligne avec icône et nombre de liens ; la catégorie qui contient la page active reste teintée en bleu quand elle est repliée. Lien actif : pastille blanche avec ombre bleutée, icône dans une tuile dégradée bleu Planificator (`#3b6cf6 → #1d4ed8`), chevron. Liens inactifs d'une catégorie sans icône, alignés sous le libellé actif (`quietIcon`).
- **Thème crème et bleu** (demande de Nizar « crème, ombre bleue ») : fond de page crème `#f6f1e7` avec halos bleus aux coins ; carte et tiroir crème translucides, fine bordure bleue, ombres portées bleues ; titres de section bleu foncé, compteurs en pastilles bleu clair, sélecteur Apparence sur fond bleu clair. En-tête (`Navbar.tsx`) crème opaque : un `backdrop-blur` y avait été essayé puis retiré, car il faisait de l'en-tête le bloc conteneur du tiroir mobile (`position: fixed`), qui se retrouvait coincé dans ses 56 px.
- **Curseur bleu glissant** (demande « slider entre les menus, défilant, interactif, en relief bleu ») : un seul curseur par menu (dégradé bleu foncé `#1b4a85 → #0f3460`, ombre bleu foncé portée, sans reflet). Il repose sur le lien actif, glisse vers le lien survolé ou qui a le focus clavier, et revient au lien actif quand le pointeur ou le focus quitte le menu. Le lien sous le curseur passe en blanc (≥ 8,8:1) ; la page active, si le curseur est ailleurs, reste marquée en bleu foncé (texte et tuile d'icône). Position mesurée (`getBoundingClientRect`) et remesurée par `ResizeObserver` (catégorie repliée / ouverte) ; pas de glissement à la première position ; `motion-reduce:transition-none`. Avant la mesure (rendu serveur), le lien actif peint lui-même le même fond bleu : aucun saut visible. Décoratif (`aria-hidden`), aucun changement de lien, d'ordre de tabulation ni d'`aria-current`. « Mon profil » (pied) garde sa pastille blanche.
- **Bleu foncé dans la barre latérale** (demande « remplace le bleu clair par le bleu foncé ») : curseur, page active, titres de section, compteurs, survol, sélecteur Apparence, bordures et ombres de la barre passent au bleu Planificator `#0f3460` (teintes `/[0.06]`, `/10`). Contrastes en clair : titres et page active 11,6:1, compteurs 9,9:1. Le logo garde ses couleurs ; les variantes sombres (`dark:`) gardent leurs bleus clairs, lisibles sur fond sombre.
- Pied commun `NavFooter` (Sidebar et MobileNav) : « Mon profil » (même lien, même libellé), sélecteur **Apparence**, puis carte d'identité avec Déconnexion.
- Inchangés : composition des liens par rôle et drapeaux serveur (`getNavItems` puis `with…NavItem`), regroupement par catégories, lien actif unique (`getActiveNavHref`), `aria-expanded` / `aria-controls`, `aria-current`, piège de focus, Échap, retour du focus. « Documents RH » n'apparaît que si le serveur le rend visible (test ajouté). La visibilité dans le menu n'est pas une autorisation.
- Piège de focus : un groupe de boutons radio n'offre qu'un arrêt de tabulation (bouton coché), comme le navigateur (correctif gardé, utile à tout groupe radio du tiroir).
- **Relief demandé élément par élément** : bouton « Export PDF mensuel » (tableau de bord) et cloche de notifications en boutons blancs surélevés (bordure et ombre bleu foncé) ; titres de section de la barre en relief gravé (reflet clair sous la lettre, aucun en sombre). Puis généralisé dans les pages (`globals.css`, contenu `data-app-shell` seulement) : tout lien ou bouton plein à texte blanc (« Rapport de paie mensuel », « Présence 30 jours », « Exporter Excel »…) reçoit une ombre bleu foncé, plus marquée au survol (spécificité nulle, une ombre de la page l'emporte ; pastilles, avatars et badges non concernés, vérifié sur 8 pages) ; les onglets segmentés (`bg-slate-100 p-1` + onglet actif `bg-white shadow-sm`, environ 7 groupes : Vue journée / Disponibilités, Semaine / Mois…) ont un rail teinté bleu foncé et un onglet actif surélevé. En sombre, l'en-tête suit l'assombrissement des surfaces blanches, tiroir mobile exclu (il garde son vrai thème sombre).

## Style de la barre latérale dans toute l'application (demande de Nizar)

- **Ombres bleues seulement, sans relief** (« pas de relief, juste les ombres ») : ombres portées teintées bleu Planificator, ni reflet intérieur, ni creux, ni soulèvement au survol. Jetons partagés dans `src/components/ui/shadows.ts` (`SHADOW_RAISED`, `SHADOW_CARD`, `SHADOW_BUTTON`, `SHADOW_SLIDER`), écrits en entier pour que `cn` (tailwind-merge) laisse une page remplacer l'ombre (`shadow-none`, `shadow-sm`…).
- **Composants partagés** (utilisés par la plupart des pages : Card dans 78 fichiers, Button 107, Input 55, Dialog 25) : cartes `rounded-2xl` avec bordure bleu clair et ombre bleue ; boutons `rounded-xl` avec ombre bleue (pleins, contour, secondaire ; rouge pour « destructive ») ; champs et zones de texte `rounded-xl`, bordure bleutée, focus bleu ; fenêtres `rounded-3xl` et menus déroulants `rounded-xl` avec ombre bleue.
- **Thème** (`globals.css`) : `--primary` = bleu Planificator `#0f3460` (boutons par défaut), `--ring` bleu, `--border` / `--input` teintés bleu, `--radius` 0,75 rem. Les boutons des pages qui imposent déjà `bg-[#0f3460]` gardent leur couleur et reçoivent l'ombre.
- **Cartes écrites à la main** (`bg-white` + bordure + coins arrondis) dans le contenu (`<main data-app-shell>`) : ombre bleue légère par une règle `:where(...)` de spécificité nulle, donc toute ombre déclarée par la page l'emporte. Aucune couleur de texte ni de fond n'est modifiée par cette règle.
- Contrôlé dans le navigateur : tableau de bord, employés, chantiers (fenêtre « Créer un chantier » ouverte puis fermée sans enregistrer), factures, planning ; tableau de bord en mobile 375 px sans défilement horizontal. Captures 29 à 32.
- Non fait : le sombre du contenu des pages (toujours le lot 2) ; les ~80 éléments bleu nuit écrits à la main hors `<Button>` (pastilles, avatars) ne sont pas modifiés.

## Apparence (Clair / Sombre / Système)

- **Bouton bascule « Mode sombre »** (demande de Nizar « un bouton bascule suffit », à la place du sélecteur Clair / Sombre / Système) : `<button role="switch">` natif (Entrée / Espace), état annoncé par `aria-checked`, dans le pied des deux menus, synchronisé entre eux et entre onglets. Tant que l'utilisateur n'a rien choisi, la préférence reste « Système » et le bouton reflète le réglage de l'appareil (suivi en direct) ; le basculer enregistre clair ou sombre. Le rond ne glisse qu'après un clic ; mouvement coupé si `prefers-reduced-motion`. Vérifié : clic, Espace au clavier, synchronisation Sidebar / tiroir, piège de focus du tiroir (bouton → Déconnexion → « Fermer le menu »).
- Préférence **par utilisateur, sur l'appareil** : `localStorage["planificator:appearance:<id>"]`. Défaut : suivre l'appareil. Aucune migration, aucune donnée serveur.
- Script inline dans `<head>` (`appearanceBootScript`) : pose `<html data-appearance="light|dark">` avant le premier rendu (pas de flash). Identifiant sérialisé en JSON, `<` échappé ; erreurs de stockage ignorées.
- **Le sombre ne s'applique qu'aux surfaces qualifiées** marquées `data-appearance-scope` : barre latérale, tiroir mobile, moitié claire de la page de connexion. Le contenu des pages reste clair.
  - Raison : une recoloration globale a été essayée puis retirée. Sur `/planning`, la case « aujourd'hui » (`bg-blue-50`) restait claire avec un texte devenu clair, donc illisible (capture 11). Il y a 187 pastilles `bg-*-50` et des couleurs fixes (`text-[#0f3460]`, 73) à reprendre page par page.
  - Mécanique : l'échelle `slate` de Tailwind passe par des variables CSS (valeurs claires identiques à la palette d'origine, donc aucun changement visuel en clair) ; elles ne s'inversent que dans `[data-appearance="dark"] [data-appearance-scope]`. La variante `dark:` de Tailwind cible la même zone.
- **Pages assombries en « Sombre »** (demandes de Nizar « assombris un peu les pages », puis « plus sombre ») : pas un thème sombre inversé, des pages nettement plus foncées dont le texte reste foncé. Fond gris `#bcbab4` avec halos bleu foncé, cartes, champs et fenêtres `#d9d7d2`, en-tête `#cdcbc5`, pastilles claires (`bg-*-50` / `bg-*-100`, 21 palettes) assombries à 84 %. Pour garder ≥ 4,5:1 : l'échelle slate fonce (400 → 700), les textes colorés de ton moyen foncent (500 → 700, 600 → 800, 700 → 900), et les textes très pâles (`text-slate-200/300` : états vides, « Sans équipe ») passent en gris atténué (les bordures du même ton ne changent pas). Limité aux pages de l'application (`:root[data-appearance="dark"]:has([data-app-shell])`) et à leurs fenêtres ; connexion, portail client et mode clair inchangés (vérifié). Contrastes mesurés en sombre (fonds composés, transparences comprises) : tableau de bord, employés et planning ≥ 4,99:1. Captures 40 à 43 (36 à 39 : première version, plus claire).
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
| Captures bureau 1200 × 760 et mobile 375 × 812, clair et sombre | Barre latérale, tiroir, connexion (dossier de notes partagé, `captures-sidebar-connexion/` ; connexion C : captures 12 à 15 ; barre latérale B : 16 à 19 ; crème et bleu : 20 à 25 ; curseur glissant : 26 à 28 ; barre en bleu foncé : 33 à 35 ; pages assombries : 36 à 39, puis plus sombres : 40 à 43 ; relief Export / cloche : 44 et 45 ; bouton bascule : 46 à 48 ; boutons pleins et onglets : 49 à 51 ; style dans toute l'application : 29 à 32 ; bureau 1280 × 800) |
| Contraste menu B, clair | ≥ 6,95:1 sur le verre (titres de section et options Apparence passés de 4,37 à 6,95:1 en `slate-600`) ; lien actif 17,85:1 |
| Contraste menu B, sombre | ≈ 5,5:1 pour les liens inactifs, titres et options ; lien actif 17,85:1 |
| Contraste connexion, clair / sombre | Clair : textes ≥ 4,76:1, texte indicatif 4,55:1 sur le fond réel du champ, bouton 12,5:1. Sombre : ≥ 5,17:1 |
| Clavier tiroir mobile | Focus initial « Fermer le menu », Tab depuis le bouton « Mode sombre » va à Déconnexion puis revient à « Fermer le menu », Échap ferme et rend le focus à « Ouvrir le menu » |
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
