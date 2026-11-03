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
| OCR | Local d'abord : couche texte du PDF (`unpdf`, déjà utilisé), bande MRZ, nom du fichier. Secours externe **préparé, désactivé** : contrat `ExternalRecognition` + drapeau, mais aucun adaptateur branché ; même drapeau activé, aucun document ne sort. |
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
| `npm run test:hr-documents` | 48 / 48 (22 existants + 26 nouveaux : spécimens OACI, chiffres faux, lignes fusionnées, ancienne CNI, classement, homonymes, nom seul, inconnu, formats réels, drapeaux, secours externe inactif, isolation entre sociétés, idempotence, absence de journalisation, reconnaissance sans écriture, migration additive, aucune option vide désactivée) |
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

- **Pas d'OCR local des images** (photos, scans sans couche texte) : seuls le nom du fichier et, si un jour autorisé, le
  secours externe les reconnaissent. Une photo de CNI nommée « IMG_2041.jpg » reste « à reconnaître ».
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
