# Petits Héros — conception

Application web **autonome** pour enfants (6–11 ans) : planning de la journée (matin → école → après l'école → soir), points gagnés en accomplissant les tâches, récompenses à échanger, badges, mini-jeu.

## Décisions

| Sujet | Décision | Raison |
|---|---|---|
| Emplacement | Dossier `enfants/` autonome, **sans lien** avec l'app Next.js Planificator | Planificator est une app métier B2B (auth, multi-société). Mélanger exposerait l'app enfant à l'auth/middleware et polluerait le produit. À terme : dépôt dédié. |
| Stack | HTML + CSS + JavaScript ES modules, `// @ts-check` + JSDoc, vérifié par `tsc --strict` (checkJs). **Zéro dépendance, zéro build.** | « Toute petite et simple ». S'ouvre directement, déployable sur n'importe quel hébergement statique. Typage strict conservé via JSDoc. Fichiers `.js` → n'entrent pas dans le `tsconfig` racine (qui n'inclut que `.ts/.tsx`). |
| Données | `localStorage`, clé `petits-heros:v1`, état versionné, **validé/assaini au chargement** (données corrompues → valeurs par défaut, entrées invalides ignorées). | Pas de backend, pas de compte, pas de données personnelles envoyées. |
| Hors-ligne | PWA : `manifest.webmanifest` + `sw.js` (stale-while-revalidate, cache versionné). Enregistré seulement en http(s). | Usage sur tablette/téléphone familial. |
| Espace parent | Porte d'accès par **question de calcul** (multiplication aléatoire 3–9 × 3–9). | Pas de code PIN à oublier. **Ce n'est pas une sécurité** : simple barrière contre les manipulations par l'enfant. |
| Sécurité UI | Aucun `innerHTML` avec des données utilisateur : construction DOM via un helper `h()` utilisant des nœuds texte. | Prévention XSS (noms/titres saisis). |

## Modèle de données (JSDoc dans `src/model.js`)

```
Period      = 'matin' | 'ecole' | 'apres' | 'soir'
Task        = { id, title, emoji, points (entier 1..100), period, days: number[] (0=dimanche..6) }
Reward      = { id, title, emoji, cost (entier 1..10000) }
Redemption  = { rewardId, title, cost, date: 'YYYY-MM-DD' }
Child       = { id, name, avatar (emoji), points (solde ≥ 0), totalEarned (≥ 0),
                tasks: Task[], completions: Record<dateKey, taskId[]>,
                perfectDays: dateKey[], redemptions: Redemption[], gameBonusDates: dateKey[] }
AppState    = { version: 1, children: Child[], activeChildId: string|null, rewards: Reward[], sound: boolean }
```

Tâches **par enfant** (âges différents), copiées depuis un modèle par défaut à la création. Récompenses **partagées**.

## Règles métier (fonctions pures, testées)

- `dateKey(date)` : date **locale** `YYYY-MM-DD` (pas `toISOString`, qui est en UTC).
- `tasksForDate(child, key)` : tâches dont `days` contient le jour de la semaine, triées par période.
- Seule la journée **d'aujourd'hui** est cochable.
- `completeTask` : +points au solde et à `totalEarned` ; refus si déjà fait ou tâche absente/non prévue ce jour. Si toutes les tâches du jour sont faites → ajoute la date à `perfectDays`.
- `undoTask` : retire les points. **Refusé si le solde < points de la tâche** (sinon exploit : cocher → dépenser → décocher → recocher). Retire la date de `perfectDays`.
- `redeemReward` : refus si solde insuffisant ; historise la redemption.
- `claimGameBonus` : +3 points, **une fois par jour**.
- `adjustPoints` (parent) : ajout/retrait manuel, solde jamais < 0 ; un ajout positif compte dans `totalEarned`.
- Série (`currentStreak`) : jours parfaits consécutifs en remontant ; les jours **sans tâche prévue** ne cassent pas la série ; aujourd'hui compte s'il est parfait, sinon on part d'hier (journée en cours). Boucle bornée (400 jours).
- `bestStreak` : plus longue série, même règle de saut.
- Niveaux par `totalEarned` : 0 Graine 🌱, 50 Pousse 🌿, 150 Explorateur 🧭, 300 Aventurier 🗺️, 500 Champion 🏅, 800 Super-héros 🦸, 1200 Légende 🌟 (+ progression 0..1 vers le suivant).
- Badges (calculés, non stockés) : premier point 🎉, 1 journée parfaite ⭐, 10 journées parfaites 🌈, série 3 🔥, série 7 🏆, 100 pts 💯, 500 pts 💎, 1re récompense 🎁, 1er memory gagné 🎮.
- Purge au chargement : `completions` > 31 jours, `perfectDays`/`gameBonusDates` > 400 jours, `redemptions` limitées aux 100 dernières.
- Ids : `crypto.randomUUID` si disponible, sinon repli `Date.now().toString(36) + Math.random()` (file:// n'est pas toujours un contexte sécurisé).

## Écrans

1. **Qui joue ?** — choix de l'enfant (gros avatars), bouton « Espace parent ».
2. **Ma journée** — en-tête (avatar, solde ⭐, niveau + barre, série 🔥) ; tâches groupées par période, période courante mise en avant (matin < 8h30, école < 16h30, après < 19h, soir ensuite) ; gros boutons à cocher ; confettis + petit son (WebAudio, coupable) ; message « Journée parfaite ! ».
3. **Récompenses** — liste, bouton « Échanger » désactivé si solde insuffisant, confirmation.
4. **Jouer** — memory 6 paires d'emojis ; victoire → +3 ⭐ une fois par jour (sinon « bravo » sans points).
5. **Badges** — grille débloqués / grisés + historique des récompenses.
6. **Espace parent** (derrière la porte de calcul) — enfants (ajouter / renommer / supprimer avec confirmation), tâches de l'enfant (ajouter / modifier titre-emoji-points-période-jours / supprimer), récompenses (ajouter / modifier / supprimer), ajustement manuel des points, son on/off, réinitialisation complète (confirmation).

Bascule de date : re-rendu au retour de visibilité et vérification chaque minute.
Accessibilité : boutons ≥ 48 px, `aria-label` sur les boutons emoji, `prefers-reduced-motion` respecté (pas de confettis), contraste suffisant.
