# Recette d'intégration locale — Next + authentification réelle + PostgreSQL (préparée, NON exécutée)

R4, 4 novembre 2026. Concerne VEHICLE-FUEL-TRIP-001 et VEHICLE-DOC-OCR-001. **Rien n'a été lancé** : ni Next, ni
PostgreSQL, ni migration, ni seed, ni réseau. Le contrôle préalable exécuté sur le worktree rend **REFUS** (voir §5).
Une exécution demande l'accord explicite de Nizar et des prérequis qui n'existent pas ici.

## 1. Ce que la recette doit prouver (et ce qu'elle ne prouve pas)

À prouver : la route réelle Next (App Router, `runtime = "nodejs"`), l'authentification NextAuth réelle (identifiants,
session, rôle, société), les refus serveur, la lecture OCR par le processus empaqueté et la persistance PostgreSQL des
dépenses saisies à partir d'une proposition.

Hors preuve même après exécution : Vercel (fork, mémoire, cwd, taille), production, fournisseurs externes (Cloudinary,
IGN, prix carburants), estimation carburant de bout en bout (appels réseau interdits), charge et concurrence réelles.

## 2. Prérequis — aucun n'est créé ici

| Prérequis | État | Qui / comment |
|---|---|---|
| Copie reconstruite hors git, **sans aucun `.env*`** : `git archive f82b54c` + `0012` + `0013` | Préparable (procédé R3.1/R4) | Next charge `.env*` au démarrage : le worktree en contient (`.env`, `.env.local`, non lus) ; il est donc exclu. |
| Dépendances dans la copie | **Décision requise** | Soit lien vers le `node_modules` déjà installé du worktree (aucune installation), soit `npm ci` (installation, non autorisée à ce jour). |
| Instance PostgreSQL locale dédiée, écoute sur 127.0.0.1, port dédié ≠ 5432, base marquée `recette`, rôle non superutilisateur | **Absente / non prouvée** | À fournir par un processus autorisé. Le contrôle ne se connecte jamais. |
| Schéma déjà appliqué (toutes les migrations du dépôt) + **attestation JSON** `{ isolated, database, port, migrations[] }` | **Absent** | Aucune migration, même jetable, n'est lancée ici. L'attestation ne vaut que déclaration ; confirmer par une lecture seule autorisée. |
| Jeu de données synthétique inséré (`scripts/verification/vehicle-recette.fixtures.ts`) | Décrit, non inséré | Mots de passe tirés à l'exécution, hachés bcrypt ; adresses `@recette.invalid`. |
| Secret de session local jetable `AUTH_SECRET` | **Décision de Nizar** | Valeur éphémère hors dépôt, jamais un secret réel ni une clé `.env`. |
| Processus OCR empaqueté dans la copie | Préparé | `npm run build:vehicle-ocr-worker` (aucun réseau). |
| **Blocage sortant effectif** (seul le bouclage autorisé) + attestation JSON `{ mechanism, scope: "loopback-only", verifiedAt }` | **Absent / non prouvé** | Indispensable : `src/app/layout.tsx` et `src/components/auth/LoginExperience.tsx` importent `next/font/google`, téléchargé par `next dev` ; d'autres appels imprévus restent possibles. Les variables seules ne suffisent pas. Aucun changement d'accès ni de style global pour le contourner. |
| Télémétrie Next coupée | À fixer au lancement | `NEXT_TELEMETRY_DISABLED=1` (sinon REFUS). |

## 3. Variables admises (noms seulement — environnement vierge, rien d'autre)

`RECETTE_DATABASE_URL`, `DATABASE_URL` (identique), `AUTH_URL=http://127.0.0.1:<port≠3110>`, `AUTH_SECRET`,
`RECETTE_SCHEMA_ATTESTATION` et `RECETTE_EGRESS_ATTESTATION` (chemins absolus), `NEXT_TELEMETRY_DISABLED=1`,
`NODE_ENV=development`, `PLANIFICATOR_VEHICLES_V3_ENABLED`,
`PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED` (selon scénario), `PATH`.
Interdits (REFUS) : toute variable `CLOUDINARY*`, `ANTHROPIC*`, `RESEND*`, `GOOGLE*`, `GMAIL*`, `NEON*`, `VERCEL*`,
`PG*`, `DIRECT_URL`, drapeaux réseau (`PLANIFICATOR_ROUTING_*`, `…_GEOCODING_*`, `…_VEHICLE_OCR_*`),
`PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED=true`, toute autre clé/jeton/secret, tout drapeau de contournement d'auth.

## 4. Procédure fail-closed

1. `node --import tsx scripts/verification/vehicle-recette-preflight.ts <copie> --forbid /Users/nizar/Development/planificator`
   dans l'environnement vierge du §3. Code 0 (`DÉCLARÉ_À_PROUVER`, meilleur verdict possible hors ligne) obligatoire ;
   2 (BLOQUÉ) ou 1 (REFUS) : arrêt. Le contrôle n'affiche que des noms et statuts, ne lit aucun `.env`, n'ouvre aucune
   connexion. Il n'existe pas de verdict « prêt » : schéma et blocage sortant ne sont que déclarés.
2. Preuves par un opérateur autorisé, avant tout lancement : lecture seule confirmant l'attestation de schéma (liste
   `_prisma_migrations` = dossiers `prisma/migrations`) ; preuve que le dispositif de blocage sortant refuse une sortie
   non bouclage sans qu'aucune requête n'atteigne un tiers (ex. journal du pare-feu, bac à sable réseau sans route).
3. Accord explicite de Nizar pour ce lancement précis.
4. `npm run build:vehicle-ocr-worker`, puis `next dev -H 127.0.0.1 -p <port>` dans la copie (bouclage seulement).
5. Scénarios §6 ; captures, réponses HTTP (codes et clés, sans valeurs personnelles), comptes de lignes avant/après.
6. Arrêt de Next, conservation des preuves, base laissée à son propriétaire (aucune suppression improvisée).
Toute connexion sortante non bouclage observée, tout écart de verdict ou toute erreur d'auth inattendue : **arrêt**.

## 5. État constaté le 4 novembre 2026 (worktree, environnement de la session)

Worktree : `REFUS` (racine sous git ; `.env`, `.env.local` présents, non lus ; une variable de jeton de la session
détectée, nom seul ; télémétrie non coupée) ; `BLOQUÉ` (pas d'URL de base, d'`AUTH_URL`, d'`AUTH_SECRET` ; schéma et
blocage sortant non prouvés). Copie reconstruite (`/private/tmp/vocr-r4/reconstruction`) : racine et `.env` OK, mêmes
autres refus et blocages, processus OCR non empaqueté. Relevé Codex (`R4/ETAT-PREREQUIS-CODEX.json`) : aucun
binaire PostgreSQL ni écoute sur 5432/55432/55433. Conclusion : **ni Next ni PostgreSQL lancés**.

## 6. Scénarios (jeu `vehicle-recette.fixtures.ts`)

| # | Scénario | Attendu |
|---|---|---|
| A1 | Connexion `admin-alpha` avec le bon mot de passe | Session, rôle ADMIN, société Alpha |
| A2 | `inactif-alpha`, mauvais mot de passe, e-mail inconnu | Refus identique, aucune session |
| A3 | Appel des routes sans session | 401 / redirection connexion, aucune lecture |
| A4 | `admin-alpha` sur `camion-beta` (autre société) | 404/403, aucune donnée Beta |
| A5 | `salarie-alpha`, `client-alpha` sur la lecture et les coûts | Refus selon l'autorité véhicule |
| B1 | Drapeau reconnaissance absent | Aucun encadré ; route 404 ; processus non lancé |
| B2 | PDF à couche texte synthétique | Propositions ; statut TEXT_LAYER ; aucune ligne créée (comptes identiques) |
| B3 | Image synthétique (OCR) | Statut OCR en < 25 s ; processus terminé (aucun survivant) |
| B4 | Carte grise synthétique avec C.3 (texte des tests de `document-recognition.test.ts`, à mettre en PDF) | C.3 absente des propositions |
| B5 | Processus OCR retiré de la copie | 503 `RECOGNITION_UNAVAILABLE`, message explicite |
| B6 | Deux lectures simultanées puis une troisième | Une à la fois ; refus borné, places rendues |
| C1 | Dépense carburant saisie depuis les propositions, enregistrée | Une ligne « À valider », provenance indiquée ; aucune validation automatique |
| C2 | Modification puis rechargement | Valeurs persistées, révision incrémentée |
| C3 | Ajout d'une pièce (stockage absent) | 503 `DOCUMENT_STORAGE_NOT_CONFIGURED`, aucun octet envoyé |
| D1 | Drapeau estimation carburant éteint | Route 404, encadré absent ; aucun appel réseau |
| D2 | Estimation et liste des séjours avec réseau | **Non couvert** : exige un environnement réseau isolé autorisé (IGN, data.economie) |

Les séjours du jeu (`recetteStays`) sont vérifiés par la règle de production dans
`tests/vehicules/v3/recette-preparation.test.ts` ; en recette réelle ils ne seraient visibles qu'avec D2.

## 7. Doubles

Aucun double dans Next : les fournisseurs externes restent absents et la recette vérifie les réponses
« indisponible ». Les doubles n'existent que dans les tests unitaires ; toute donnée insérée porte « RECETTE »,
toute éventuelle donnée factice future le préfixe `DOUBLE-RECETTE-`.
