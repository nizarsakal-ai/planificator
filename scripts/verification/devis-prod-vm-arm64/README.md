# Harnais VM hors ligne : candidat de production « devis » (main e952b2ec + destinataire et bon de commande client)

06/11/2026. **PRÉPARÉ, NON EXÉCUTÉ.** Codex doit relire ce harnais **avant tout média**.

- **Contenu du candidat** : `main` GitHub `e952b2ec99043f93aa3fe4e5fdcfa46aaab144c9` (arbre `6c683d34…`) plus le seul lot devis, destinataire et bon de commande (code identique à `a6964aa5`, relu). **Aucun lot A à H n'est présent.**
- **VM et compte** : même VM UTM Debian 13 ARM64 et même compte non root que pour la v6. Réseau : `Network=[]`.

## Ce que ce dossier contient (autonome : `main` n'a pas `scripts/verification/v2-vm-arm64`)
| Fichier | Origine |
|---|---|
| `lancer-devis-prod-vm-arm64.sh`, `harnais-devis-prod-vm-arm64.sh` | Harnais v6 repris à l'identique (refus avant action, empreintes T1, média en lecture seule, arbre exact, bubblewrap) ; seuls changent le répertoire de travail, le contrôle d'identité et la phase appelée |
| `phase-devis-prod-vm-arm64.sh` | Sections 0 à 4 de la phase v6 identiques, à une ligne près : le chemin de `generer-mock-polices.cjs`. Section 5 : suites devis et régressions facturation. Section 6 : contrôle applicatif et captures. |
| `generer-mock-polices.cjs`, `fabriquer-iso-mac.sh` | **Copies exactes** du harnais v6 (`fabriquer-iso-mac.sh` : `54e4f71ec09b51243b30fde622268f44db433f09636b1cff3bc1e681543cde1a`) |
| `donnees/npm-archives-linux-arm64-glibc.tsv` | Recalculé depuis le `package-lock.json` de `main` (`a8c3086f…`), avec l'algorithme qui **reproduit exactement** la liste v6. **Ensemble URL + intégrité identique à la liste v6** (955 archives). |
| `donnees/moteurs-prisma-…tsv`, `donnees/polices-google.tsv` | Copies v6 : Prisma 5.22.0, Next 15.5.18, polices Inter et Instrument Serif inchangées sur `main` |
| `seed-synthetique-devis.ts`, `captures-devis-puppeteer.mjs` | Données fictives et 8 captures des deux dialogues. Les fonds V1 sont identiques sur `main` : règles CSS comparées. |

## Suites exécutées dans le confinement (arrêt au premier échec, journal par suite)
- **Suites** : `test:navigation`, `test:devis-v2`, `test:devis-v2:actions`, `test:devis-v2:pg`, `test:billing:c1`, `c1:pg`, `c2`, `c2:pg`, `c3`, `c3:pg`, `test:billing:pdf`.
- **Régressions des chemins modifiés**, une base jetable distincte par fichier : `p1-05-p2-04-quote-token`, `p1-06-draft-update-rollback`, `p2-03-document-snapshot`, `r3-decision-clock`, `r7-s1-deductions-quote`, `r8-s2-lock-order`, `r12-t1-deposit-reallocation`.
- **Ensuite** : `lint`, contrôle applicatif sur `controle_devis` (`BILLING_COMPLETE_ENABLED=true` seulement ; aucun courrier réel, faute de `BILLING_MAIL_ENABLED`), puis captures.

## Média, sans téléchargement (Codex Mac, sur le Mac)
1. **Entrées**
   - Contrôler le paquet du candidat avec `shasum -a 256 -c SHA256SUMS.txt`.
   - Contrôler le support v5 :
     - `shasum -a 256 <media-v5>/support/MANIFESTE-MEDIA.sha256` doit donner `22273074a6f63183788f125890470ac67d81bf8e6c0a4f544b9cca9ed825ac08` ;
     - `cd <media-v5>/support && shasum -a 256 -c MANIFESTE-MEDIA.sha256` doit être entièrement OK.
2. **Contrôle de réutilisation des archives npm** : l'ensemble des intégrités de `<media-v5>/support/npm/INDEX.tsv` (2e colonne) doit être **égal** à celui de la 2e colonne de `donnees/npm-archives-linux-arm64-glibc.tsv` de ce candidat (lignes `#` exclues, comparaison par `sort -u`). Tout écart arrête la procédure : pas de média.
3. **Dossier neuf** : `<media-prod>` ne doit pas exister. Lancer `mkdir -p <media-prod>/support/source <media-prod>/support/harnais-devis-prod <media-prod>/x`.
4. **Copie depuis le support v5**, qui n'est pas modifié : `cp -Rp <media-v5>/support/npm <media-v5>/support/prisma <media-v5>/support/polices <media-prod>/support/`.
5. **Données de ce candidat** : `cp -p` des trois `*.tsv` de `x/scripts/verification/devis-prod-vm-arm64/donnees/` vers `<media-prod>/support/`, après l'extraction de l'étape 6.
6. **Source et harnais**, extraits du **tar vérifié** et jamais d'un dossier courant. **Une seule sélection, qui contient aussi `fabriquer-iso-mac.sh`** :
   - `tar -xf <SOURCE-ARBRE-candidat.tar> -C <media-prod>/x scripts/verification/devis-prod-vm-arm64` ;
   - `cp -p <tar> <liste FICHIERS-SHA256> <media-prod>/support/source/` ;
   - `cp -p <media-prod>/x/scripts/verification/devis-prod-vm-arm64/lancer-devis-prod-vm-arm64.sh <media-prod>/x/scripts/verification/devis-prod-vm-arm64/harnais-devis-prod-vm-arm64.sh <media-prod>/support/harnais-devis-prod/`.
7. **Rien en trop** : `support/` contient seulement `npm/`, `prisma/`, `polices/`, `source/` (2 fichiers), `harnais-devis-prod/` (2 scripts) et les 3 `*.tsv`.
8. **Manifeste** : depuis `support/`, `find . -type f ! -name MANIFESTE-MEDIA.sha256 | LC_ALL=C sort | while read -r f; do shasum -a 256 "$f"; done > MANIFESTE-MEDIA.sha256`. Noter le MSHA.
9. **ISO**
   - `shasum -a 256 <media-prod>/x/scripts/verification/devis-prod-vm-arm64/fabriquer-iso-mac.sh` doit donner `54e4f71e…cde1a`.
   - Lancer `sh <media-prod>/x/scripts/verification/devis-prod-vm-arm64/fabriquer-iso-mac.sh <media-prod>/support <media-prod>/PLANIF-DEVIS-PROD.iso <MSHA>`.
   - Le volume s'appelle `PLANIF_V2_AH`, nom fixé par le script, qui n'est pas modifié. Seul le nom de fichier distingue l'ISO.
   - Vérifier ensuite le détachement : `mount | grep -F '/tmp/planif-iso.'` et `hdiutil info | grep -F 'PLANIF-DEVIS-PROD.iso'` doivent être vides.

## Dans la VM
1. **Root** : démonter tout média précédent, attacher l'ISO en lecture seule, `mount -t udf -o ro /dev/sr1 /mnt/tst`, puis vérifier les noms exacts.
2. **Compte non root existant** : `sh /mnt/tst/harnais-devis-prod/lancer-devis-prod-vm-arm64.sh /mnt/tst <MSHA> <arbre du candidat>`.
3. **Preuves à rapatrier** depuis `/var/tmp/planificator-devis-prod.*/preuves` :
   - `isolation.txt`, `pg-attestation.txt`, `versions.txt` ;
   - les journaux de chaque suite (dont `fix-*.log`) ;
   - `devis-synthetique.json` ;
   - `captures-devis/` (8 captures et `resultats.json`) ;
   - `MANIFESTE-SHA256.txt`.

Un échec arrête le harnais : c'est une preuve à conserver. **Aucun PASS sans ces preuves.** Une mise en production exige des preuves réussies, la cible identifiée et la procédure de migration et de retour arrière du paquet.

## Lint non interactif et reprise de la campagne 02 (07/11/2026, PRÉPARÉ, NON EXÉCUTÉ, relecture Codex requise)
**Constat.** La campagne 02 de `7e6038df` s'est bloquée sur `npm run lint` : `main` n'a **aucune configuration ESLint** et `next lint` (next 15.5.18) ouvre alors un assistant interactif (Strict / Base / Cancel). `next build` ignore ESLint quand aucune configuration n'existe : la production n'a jamais été lintée. On **n'ajoute pas** de configuration au produit, car elle activerait ESLint dans le build Vercel, ce qui sort du périmètre.

**Contrôle** (`controle-lint.sh`, appelé par la phase à la place de `npm run lint`) :
- **Si une configuration existe** : `npm run lint`, entrée fermée, bloquant.
- **Sinon** :
  - constat écrit ;
  - lint **informatif** de tout `src/`, non bloquant ;
  - lint **bloquant** des 19 fichiers `src/` du lot (`fichiers-lint-lot.txt`) avec la configuration que « Strict » aurait écrite (`eslint-controle.json` : `next/core-web-vitals` et `next/typescript`). La règle de sortie est celle de `next lint` : échec sur erreur, avertissements consignés, couverture vérifiée fichier par fichier.

**Reprise sans refaire le build** (`lancer-reprise-…`, `reprise-…`, `phase-reprise-…`). Le script réutilise le répertoire de la campagne interrompue :
- **conservés** : `node_modules`, client Prisma, moteurs revérifiés, `.next` ;
- **gelées** : les preuves acquises reçoivent un manifeste **avant** toute action, sont passées en lecture seule et montées en lecture seule ;
- **vérifié** : le produit doit être égal, empreinte par empreinte, à celui de l'arbre de reprise ;
- **exécutés ensuite** : le lint, un PostgreSQL 17 **neuf** distinct (`pg-reprise`) attesté avant tout DDL, puis la section 6 (contrôle applicatif et captures, à l'identique).

**Refus** de la reprise dans les cas suivants :
- la campagne est encore active ;
- elle ne s'est pas arrêtée sur le lint ;
- une preuve acquise manque ;
- une reprise a déjà été tentée ;
- un fichier produit diffère.

Le recours est alors une campagne complète neuve de l'arbre de reprise, avec la procédure média ci-dessus.

**Média de reprise** : procédure média ci-dessus, avec l'arbre de reprise, et `harnais-devis-prod/` contenant **4** scripts : les 2 du harnais, plus `lancer-reprise-devis-prod-vm-arm64.sh` et `reprise-devis-prod-vm-arm64.sh`.

**VM** : `sh /mnt/tst/harnais-devis-prod/lancer-reprise-devis-prod-vm-arm64.sh /mnt/tst <MSHA> <arbre-reprise> /var/tmp/planificator-devis-prod.XXXXXX <arbre-initial>`. Preuves dans `…/preuves-reprise/` (`MANIFESTE-SHA256.txt`, `MANIFESTE-PREUVES-CAMPAGNE-INITIALE.txt`, `lint-*.txt|json`, journaux de la section 6, captures).

## v11 : reprise refusée sur `./public/sw.js`, artefacts PWA et nouvelle tentative (07/11/2026, PRÉPARÉ, NON EXÉCUTÉ)
**Cause.** `@ducanh2912/next-pwa` 10.2.9 (`dest: "public"` dans `next.config.ts`) **supprime puis régénère** à chaque `next build` les fichiers suivants : `public/sw.js(.map)` et `public/{workbox,fallback,swe-worker,worker}-*.js(.map)`. Ce sont les propres motifs de nettoyage de next-pwa.
- Le `public/sw.js` suivi dans l'arbre référence une compilation antérieure (`k24O5WI8-VDvQRcWTQfMt`).
- La comparaison stricte de la reprise v10 ne pouvait donc qu'échouer après la compilation de la campagne.

**Contrôle v11** (`reprise-…`, section R4)
- **Sources** : tout fichier hors du dossier du harnais et hors des artefacts PWA doit avoir une empreinte identique. **Tous** les écarts sont listés dans `ecarts-produit.txt`, puis la reprise est refusée.
- **Artefacts PWA** : différence admise **seulement** si leur provenance de la compilation réutilisée est prouvée :
  - le journal `16-build.log` contient `(pwa) Service worker: /travail/repo/public/sw.js` ;
  - `public/sw.js` référence `/_next/static/<BUILD_ID>/_buildManifest.js` de `.next/BUILD_ID` ;
  - chaque `workbox-*`, `swe-worker-*`, etc. référencé existe.
- Les empreintes suivies et régénérées sont consignées.

**Tentatives**
- La 1re tentative utilise `preuves-reprise`, `reprise-arbre` et `pg-reprise`. La k-ième utilise `preuves-reprise-k`, `reprise-k-arbre` et `pg-reprise-k`.
- Une nouvelle tentative n'est admise que si chaque tentative précédente a été refusée **avant** le confinement : ni phase confinée, ni cluster, ni manifeste final.
- Le manifeste des preuves acquises doit être **identique** à celui de chaque tentative précédente.
- Les preuves des tentatives précédentes sont gelées et montées en lecture seule. Rien n'est effacé.

## v12 : captures de la reprise n° 2 en échec, connexion impossible (07/11/2026, PRÉPARÉ, NON EXÉCUTÉ)
**Cause, établie dans les sources** : `next start` tourne avec `NODE_ENV=production`, hors Vercel.
- `@auth/core` 0.41.2 (`lib/utils/env.js`) ne fait confiance à l'hôte que si l'une de ces variables est définie : `AUTH_URL`, `AUTH_TRUST_HOST`, `VERCEL` ou `CF_PAGES`, ou si `NODE_ENV` vaut autre chose que `production`.
- `NEXTAUTH_URL`, seule variable exportée par la section 6, **ne compte pas**.
- Conséquence : `UntrustedHost` sur `/api/auth/*`, la connexion échoue et la page reste sur `/login`. C'est le délai de 20 s de `captures-devis-puppeteer.mjs:63`.
- La production n'est pas concernée : `VERCEL` y est défini.

**Correctif** : section 6 de la phase et de la phase de reprise, `AUTH_TRUST_HOST=true` (serveur confiné sur la boucle locale, sans réseau). Le produit n'est pas modifié.

**Reprise des seules captures**
- Une tentative précédente est admise **(B)** si toutes ces conditions sont réunies :
  - son lint du lot est réussi (`fichiers=19 erreurs=0 … code_eslint=0`) ;
  - elle a échoué exactement à l'étape `captures-devis` ;
  - ses journaux `controle-*` sont présents ;
  - son `controle-serveur.log` atteste `UntrustedHost`.
- La nouvelle tentative (`reprise-3`) rejoue alors seulement la section 6 : base neuve, migration, seed, devis synthétiques, serveur, captures. **Le lint n'est pas rejoué** ; il est référencé dans `lint-acquis.txt`.
- Les preuves antérieures sont gelées et montées en lecture seule.

## v13 : captures de la reprise n° 3, 8/8 en échec par ciblage du mauvais dialogue (07/11/2026, PRÉPARÉ, NON EXÉCUTÉ)
**Preuves** (`preuves-reprise-3`)
- **Connexion réparée** : aucun `UntrustedHost` dans le journal serveur.
- **Bureau** : 4 fois « Waiting for selector `[role="dialog"]` failed ».
- **Mobile, envoi** : nom et e-mail pré-remplis conformes, mais « Envoyer à … » est déclaré absent alors que la capture le montre.
- **Mobile, facturation** : refus de `BC-Ж` déclaré absent. La capture montre `BC-BC-2026-0001` : la saisie n'avait pas été effacée.

**Cause, dans les sources** : `MobileNav.tsx:114` est **toujours monté** avec `role="dialog"`. Fermé, il est `aria-hidden` et `inert`, et `md:hidden` au bureau. Il précède dans le DOM le portail Radix.
- Le script attendait et lisait le **premier** `[role="dialog"]` :
  - au bureau, c'était le menu caché, d'où l'attente sans fin ;
  - sur mobile, c'était le menu hors écran, d'où des assertions de texte fausses.
- En émulation tactile, le triple clic ne sélectionnait pas le texte du champ.

**Correctif** (`captures-devis-puppeteer.mjs`, assertions métier **inchangées**)
- **Ciblage** : le dialogue est le dialogue Radix `[role="dialog"][data-state="open"]`, non `aria-hidden`, visible, avec le titre attendu (« Envoyer le devis » ou « Créer la facture depuis ce devis ») et son champ (`#rec-email` ou `#po-ref`). Toutes les lectures se font **dans** ce dialogue.
- **Rendu stabilisé** : opacité 1 et aucune animation en cours, avant les assertions et avant la capture.
- **Saisie** : sélection par `el.select()`, puis vérification de la valeur obtenue. Les messages, refus de `BC-Ж` puis acceptation de `BC-2026-0001`, sont attendus avec une limite de 5 s.
- **Fermeture** : par Échap, vérifiée.
- **Diagnostics** dans `resultats.json` : dialogues présents (état, `aria-hidden`, `inert`, géométrie), largeur de la fenêtre, débordement horizontal du dialogue et éléments qui débordent.
- Le débordement est un **constat** séparé, compté dans `debordements` et non masqué.

**Reprise** : une tentative (B) en échec aux captures n'est admise que pour une cause **attestée** :
- `UntrustedHost` (v12) ;
- ou 8 résultats évalués dont **tous** les problèmes sont exactement ceux du ciblage du dialogue (v13).

Toute autre cause est refusée, pour éviter les reprises à l'aveugle. Le lint reste acquis de la tentative qui l'a réussi.

## v14 : correctif produit du débordement mobile et validation ciblée (07/11/2026, PRÉPARÉ, NON EXÉCUTÉ)
**Produit modifié**, sur décision transmise par la coordination (Nizar) : `src/components/devis/QuoteSendDialog.tsx`, **classes CSS seulement**.
- L'adresse reste **complète** et passe à la ligne n'importe où (`[overflow-wrap:anywhere]`).
- `min-w-0` est posé sur le formulaire, les cellules de la grille et les lignes de contact.
- Le pied passe en `flex-wrap`, et le bouton « Envoyer à … » peut s'étendre sur plusieurs lignes.
- Design V1 conservé ; aucun changement métier.

**Captures** : un débordement horizontal est désormais un **ÉCHEC**. L'état d'attente d'animation est lu par `Animation.pending`.

**Validation proportionnée** : `lancer-devis-prod-vm-arm64.sh <média> <MSHA> <arbre> cible`.
- **Exécuté** sur un arbre neuf : isolation, installation hors ligne, compilation (**rebuild nécessaire**), PostgreSQL neuf, lint des 19 fichiers du lot, section 6 avec les 8 captures.
- **Non rejoué** : les suites de la section 5, avec justification écrite (`suites-non-rejouees.txt`) et contrôle bloquant qu'aucun fichier de `tests/` n'importe `src/components/devis/`. Ces suites sont acquises de la campagne 02.
- Les scripts de **reprise** ne s'appliquent plus à ce produit : ils refuseraient, à juste titre, la source modifiée.
