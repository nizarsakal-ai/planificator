# PLV2-DOC-RH-002 — Documents RH : tous les documents, reconnaissance locale, fiche à compléter

Base : `origin/main` = `a7d5d56`. Branche locale `feat/hr-documents-recognition`, worktree isolé
`/Users/nizar/Development/planificator-hr-recognition`. Demande de Nizar du 3 novembre 2026 ; choix confirmés par la
coordination (Codex) avec les recommandations affichées. **Rien de poussé, aucun build distant, aucune migration ni
aucun déploiement en production.** Rôles : Claude implémente, Hermès relit (mission préparée), Codex vérifie le diff
et les preuves.

## Décisions appliquées

| Sujet | Décision |
|-------|----------|
| Validation | Préremplissage + validation humaine obligatoire : case « J'ai vérifié la proposition » au dépôt, revue existante avant publication, case « J'ai comparé ces informations » avant de créer une fiche. Rien n'est rangé, créé ni publié automatiquement. |
| OCR | Local d'abord : couche texte du PDF (`unpdf`, déjà utilisé), sinon **OCR local réel** (Tesseract WASM, modèles fra/eng lus sur le disque) pour les scans et les photos. Secours externe **préparé, désactivé** : contrat `ExternalRecognition` + drapeau, mais aucun adaptateur branché ; même drapeau activé, aucun document ne sort. |
| Nom du fichier | Ne sert qu'à **suggérer** un type, une période ou un salarié existant, toujours marqué « nom du fichier — non lu sur la pièce ». Il ne remplit **jamais** un champ d'identité. |
| Fiche à compléter | Employé et compte **inactifs**, adresse réservée `rh-fiche-<uuid>@fiche-a-completer.invalid`, mot de passe aléatoire jamais transmis, **aucune invitation**. Dépôt et revue possibles, **publication refusée** (`DRAFT_EMPLOYEE`). |
| Formats | PDF toujours ; JPG, PNG, HEIC derrière leur drapeau. Type réel lu dans les octets (signature + fin de fichier), jamais dans le nom ni le type déclaré. Téléchargement toujours en pièce jointe, `nosniff`, CSP `sandbox`. |
| Numéros | Jamais conservés ni renvoyés en entier : 4 derniers caractères seulement (`documentNumberEnd`). |
| Photo | Proposition à confirmer : découpe de la zone photo standard de la pièce (images JPG/PNG), **sans détection ni reconnaissance du visage**. Stockée comme document RH privé `ID_PHOTO` si l'opérateur coche la case ; `avatarUrl` (public) n'est pas modifié. |

## Réalisation

- `src/lib/hr-documents/catalog.ts` : 18 catégories (4 historiques + identité, contrat, paie, social, santé,
  qualification). `category` reste une chaîne : **aucune migration** pour les catégories.
- `src/lib/hr-documents/recognition/mrz.ts` : OACI 9303 TD3 (passeport), TD1 (CNI 2021, titres de séjour), TD2,
  ancienne CNI française ; chiffres de contrôle 7-3-1 ; lecture tolérante aux lignes fusionnées par l'extraction PDF.
- `src/lib/hr-documents/recognition/engine.ts` : classement par règles (MRZ, puis mots-clés du texte, puis nom du
  fichier), période (expiration, « Période du », mois en lettres), rapprochement des personnes (STRONG nom + prénom,
  PARTIAL nom seul ; **homonymes : aucun salarié proposé**), confiance par champ et source affichée.
- `POST /api/hr-documents/recognize` : proposition sans aucune écriture ni journalisation. `POST /api/hr-documents/employees` :
  fiche à compléter, idempotente par clé. Les deux vérifient l'origine, la session, le drapeau, puis la capacité IMPORT
  de l'opérateur (configuration explicite, jamais le rôle seul).
- Écran `Documents.tsx` : proposition préremplie, indice de source et de confiance (« à vérifier » en ambre sous 0,7),
  alerte homonymes, bloc « Personne absente — créer une fiche à compléter ». Libellés inchangés quand les drapeaux sont absents.
- Schéma : nouveau modèle `HrEmployeeDraft` (table `hr_employee_drafts`), relation inverse seulement sur `Employee`.
  Migration `20261103120000_hr_employee_drafts` **additive** (nouvelle table) ; `employees`, `users`, `hr_documents`
  inchangés. **Préparée, appliquée seulement sur des bases Docker locales jetables.**

## OCR local (complément du 3 novembre 2026, après la recette sur la pièce réelle)

Constat de Nizar : « l'agent n'a pas pu extraire toutes les infos » — un scan iPhone (PDF d'une seule image, sans couche
texte) n'était pas lu du tout. Correctif :

- **Capacités réutilisées** : `extractPdfTextLayer` (couche texte), `unpdf.extractImages` (image de chaque page d'un scan),
  `sharp` (décodage, orientation EXIF, prétraitement). **Ajouté** (copie isolée seulement) : `tesseract.js` 7.0.0 et les
  modèles `@tesseract.js-data/fra` et `eng` 1.0.0 (variante `best_int`, 0,7 Mo et 3 Mo). Modèles lus par chemin local,
  `cacheMethod: "none"` : aucun téléchargement, aucun cache écrit, rien n'est envoyé hors du serveur.
- `src/lib/hr-documents/recognition/ocr.ts` — `readDocument` : couche texte (≥ 40 caractères utiles) sinon images des pages
  (3 pages, 50 Mpx au plus) → niveaux de gris, contraste, côté long 2 000 px → passe texte (fra) ; si elle est faible, sondes
  à 90/180/270° puis passe complète sur la meilleure ; **carte posée sur une page A4** : la bande MRZ repérée par la passe
  texte situe la carte, qui est relue seule, agrandie ; passe MRZ dédiée (alphabet MRZ seul) sur la zone repérée, le bas de
  l'image, la page, puis le bas des autres orientations. Délai global 45 s, workers libérés après 60 s d'inactivité.
- **Statuts distincts** : `TEXT_LAYER`, `OCR`, `ENGINE_MISSING` (paquet ou modèle absent), `TECHNICAL_FAILURE` avec motif
  (`TIMEOUT`, `IMAGE_NOT_DECODABLE`, `PAGE_RENDER_UNAVAILABLE`, `PDF_UNREADABLE`, `OCR_ERROR`), `UNREADABLE` **seulement
  après une vraie passe OCR**. Affichés tels quels à l'écran (« Ce n'est pas un constat d'illisibilité » pour un échec).
- `mrz.ts` : gabarit positionnel (un O lu dans une zone de chiffres redevient 0, etc. — les chiffres de contrôle valident
  ensuite), « < » lus K ou L restaurés, longueur tolérée à ±2–4 « < » de fin, ligne des noms TD1 abîmée en fin de ligne,
  **contrôle par zone** (numéro, naissance, expiration, composite), choix de la lecture aux contrôles justes parmi toutes,
  une ligne lue deux fois ne peut servir de ligne des noms.
- `engine.ts` : libellés imprimés lus (NOM / Surname, Prénoms, Sexe, Nationalité, dates, y compris en colonnes). Choix par
  champ : date MRZ si **sa** zone est contrôlée (0,95), sinon libellé (0,65–0,8), sinon MRZ non contrôlée (0,5). Noms, sexe,
  nationalité ne sont couverts par aucun chiffre de contrôle : sûrs (0,95) seulement si MRZ et libellé concordent ; noms
  MRZ seuls = « à vérifier » (0,65). Fin de numéro reprise seulement si son contrôle est juste. **Chaque champ vide porte
  son motif** (`missing`) : rien lu (avec la raison de lecture), absent du texte lu, absent de ce modèle de pièce,
  `UNCERTAIN` (lu mais trop incertain, ex. prénom réduit à une lettre isolée).

### Banc de mesure — pièces entièrement synthétiques (`npm run bench:hr-documents:ocr`)

Personnes fictives, numéros inventés, cartes dessinées (mise en page inspirée, sans graphisme officiel). MacBook local,
moteur déjà chargé après la première pièce. ✅ juste · ⬜ vide (motif affiché) · ❌ faux.

| Pièce | Lecture | Rot. | MRZ | Temps | Type | Nom | Prénoms | Naiss. | Sexe | Nat. | Expir. | Fin n° | Période |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CNI — PNG net | OCR | 0 | invalide | 2,0 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | — |
| CNI — photo JPEG bruitée | OCR | 0 | valide | 1,8 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| CNI — photo pivotée 90° | OCR | 0 | invalide | 3,2 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | — |
| CNI — photo à l'envers 180° | OCR | 180 | valide | 3,2 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| CNI — scan PDF sans couche texte | OCR | 0 | valide | 2,0 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| CNI — photo basse résolution | OCR | 0 | valide | 1,5 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Passeport — photo JPEG | OCR | 0 | valide | 1,2 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Passeport — scan PDF | OCR | 0 | valide | 1,3 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Titre de séjour — photo JPEG | OCR | 0 | valide | 1,9 s | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Bulletin — scan PDF | OCR | 0 | — | 2,4 s | ✅ | — | — | — | — | — | — | — | ✅ |
| Photo floue (illisible attendu) | UNREADABLE | 0 | — | 2,5 s | — | — | — | — | — | — | — | — | — |

| Champ | Justes | Faux | Vides | Taux |
|---|---|---|---|---|
| Type | 10/10 | 0 | 0 | 100 % |
| Nom, prénoms, naissance, sexe, nationalité, expiration | 9/9 chacun | 0 | 0 | 100 % |
| Fin de numéro | 7/9 | 0 | 2 (contrôle du numéro faux → non repris) | 78 % |
| Période (bulletin) | 1/1 | 0 | 0 | 100 % |

Lecture initiale de la première pièce (chargement du moteur) : environ 1 s de plus. Navigateur local (scan PDF synthétique
dessiné dans la page, 655 px) : lu en 2,8 s, type « à vérifier » (MRZ incomplète), six champs préremplis justes, aucun
défilement horizontal.

**Pièce réelle de la recette** (aucune valeur reproduite ici, ni dans git, ni dans les journaux) : avant, rien n'était
lu. Après : OCR en 4,6 s ; carte localisée sur la page A4 ; bande MRZ lue avec **tous ses chiffres de contrôle justes** ;
type, naissance, expiration (0,95), sexe et nationalité (0,85) proposés ; nom proposé « à vérifier » (ligne des noms non
contrôlée et lue de façon instable) ; prénom laissé vide, motif « lu, mais trop incertain ». Aucun libellé imprimé reconnu
sur cette pièce. Mesure faite par un diagnostic structurel qui n'affiche que statuts, sources et booléens.

**Pas de promesse de 100 %** : les pièces synthétiques sont propres comparées à une vraie photo (reflets, hologrammes,
police OCR-B réelle, plis). La validation humaine reste obligatoire et chaque champ est marqué « lu », « à vérifier » ou
« non lu : motif ».

## Drapeaux (tous absents = comportement de production actuel)

```
HR_DOCUMENT_EXTENDED_CATEGORIES_ENABLED=false
HR_DOCUMENT_IMAGES_ENABLED=false
HR_DOCUMENT_RECOGNITION_ENABLED=false
HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED=false
HR_DOCUMENT_EXTERNAL_RECOGNITION_ENABLED=false   # sans effet tant qu'aucun adaptateur n'est autorisé
```

`HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED` exige la migration appliquée ; les autres n'en exigent aucune.

## Preuves (locales, données synthétiques uniquement)

| Contrôle | Résultat |
|----------|----------|
| `npm run test:hr-documents` (après OCR) | **65 / 65**, dont 8 OCR (couche texte sans moteur, scan PDF → image → OCR, moteur absent, échecs techniques avec motif, illisible seulement après OCR, orientation bornée, 2 lectures Tesseract réelles) et 7 de lecture (MRZ abîmée réparée, contrôle par zone, meilleure lecture, ligne dupliquée refusée, noms non protégés, prénom incertain, libellés en colonnes) ; nom de fichier jamais lu comme identité |
| `npm run test:hr-documents` (lot initial) | 48 / 48 (22 existants + 26 nouveaux : spécimens OACI, chiffres faux, lignes fusionnées, ancienne CNI, classement, homonymes, nom seul, inconnu, formats réels, drapeaux, secours externe inactif, isolation entre sociétés, idempotence, absence de journalisation, reconnaissance sans écriture, migration additive, aucune option vide désactivée) |
| `test:hr-documents:pg` (PostgreSQL Docker jetable `planificator_hr_docs_test`) | 25 / 25, dont 2 nouveaux : fiche inactive à adresse `.invalid` sans invitation, dépôt et revue acceptés, publication refusée ; isolation entre sociétés ; drapeau coupé |
| Migration | appliquée sans erreur sur la base jetable ; `prisma migrate diff` : **aucune** ligne concernant `hr_employee_drafts` (les écarts restants sont antérieurs et sans rapport : véhicules, Gmail) |
| `typecheck:hr-documents` | 0 erreur ; `tsc` complet : 52 diagnostics, inchangés (préexistants, tests hors périmètre) |
| `npm run build` | réussi |
| Navigateur (local, compte admin du seed, 1280 px et 375 px) | passeport spécimen : type, nom, prénoms, naissance, sexe, nationalité, expiration lus en MRZ, numéro réduit à `…02C3` ; bulletin : type et période depuis le texte, salarié depuis le nom du fichier « à vérifier » ; « CNI JEAN DUPONT.pdf » : type et salarié depuis le nom du fichier ; carte JPG fictive : fiche proposée + photo proposée ; création refusée sans la case, acceptée avec, fiche aussitôt sélectionnée ; aucune largeur horizontale en 375 px |
| Base locale après création | employé inactif, compte inactif `@fiche-a-completer.invalid`, 0 invitation, champs d'identité et `02C3` seulement, statut OPEN |

Régression trouvée et corrigée pendant la recette : une option vide `disabled` laissait le navigateur présélectionner
**le premier salarié** quand la proposition arrivait avant la liste. Options vides désormais sélectionnables (le champ
`required` bloque l'envoi) et formulaire reconstruit au chargement de la liste ; test de garde ajouté.

## Non vérifié / limites

- **OCR** : pas de rendu des pages PDF purement vectorielles sans couche texte ni image (pas de moteur de rendu canvas
  installé) → `TECHNICAL_FAILURE / PAGE_RENDER_UNAVAILABLE`, rare pour un scan. **HEIC** : la libvips livrée avec `sharp`
  ne décode que l'AVIF → `IMAGE_NOT_DECODABLE` (demander un JPG). Pas de modèle OCR-B dédié à la MRZ : modèle `eng` avec
  alphabet restreint ; la police réelle des pièces n'a été approchée que par une monospace grasse. Orientation : sondes à
  90° près, pas de redressement fin d'une photo de travers. Verso seul (sans libellés) : noms issus de la MRZ seule, donc
  « à vérifier ».
- **Production non vérifiée** : taille du bundle (moteur WASM, `tesseract.js-core` ≈ 43 Mo installés, plusieurs variantes),
  inclusion des modèles dans la fonction (`outputFileTracingIncludes` ajouté pour `/api/hr-documents/recognize`, non
  rejoué sans build), mémoire (≈ 100 Mo par instance chaude) et durée (jusqu'à 45 s) sur Vercel. Sans modèles embarqués,
  le statut affiché est « moteur absent », jamais « illisible ». Aucun build ni déploiement fait pour ce complément.
- Dépôt de bout en bout vers le stockage Drive privé : non rejoué (pas de Drive en local) ; le chemin existant est
  inchangé hormis le type MIME et l'extension. Message « stockage non configuré » vérifié.
- Recadrage photo : zone fixe (cartes et pages de passeport standard) ; mauvais cadrage possible sur une photo de
  travers : c'est pourquoi la photo reste une proposition à cocher. HEIC : pas d'aperçu photo (navigateurs).
- `avatarUrl` non alimenté (stockage public) : la photo reste privée dans les documents RH.
- Les fiches à compléter apparaissent comme salariés inactifs dans « Personnel » (onglet archivés) sans marqueur
  spécifique hors module RH.
- Rappels d'expiration : non réalisés (aucun cron nouveau) ; les dates sont enregistrées pour un lot suivant.
- Revue Hermès : **mission préparée, non transmise** (passerelle VPS indisponible d'après la coordination) ; aucune revue
  ne lui est attribuée tant que son résultat n'est pas reçu.
- Safari / iOS sur appareil réel.
