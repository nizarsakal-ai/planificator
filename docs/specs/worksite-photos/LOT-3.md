# SPEC-WORKSITE-PHOTOS-001 — Lot 3 — Upload ouvrier, réservation, proxy et page

| Champ | Valeur |
|-------|--------|
| **SPEC / ADR** | SPEC-WORKSITE-PHOTOS-001 (Acceptée), ADR-PLAN-005 (Accepté) — sur `feat/worksite-photos-lot-0`, non fusionnée |
| **Lot** | 3 — flux d'upload complet (§7.1) : pré-autorisation avant lecture du corps, validation du fichier, réservation (clé d'idempotence, identifiant Drive préalloué, bail), dossiers, création Drive idempotente, transaction de rattachement (verrous, relecture des droits, CAS, photo `PENDING`, événement) ; lectures (contexte, liste paginée, proxy privé du fichier) ; compression côté client ; page `/photos-engins` ; lien de navigation ; exclusions PWA. **Aucune API agent, aucun cron, aucune suppression (ni UI ni requête).** |
| **Branche** | `feat/worksite-photos-lot-3`, **empilée sur `feat/worksite-photos-lot-2`** (révisé `faf2d2f` après la revue Codex du Lot 2 ; auparavant `92d48cb`, lui-même sur le Lot 1 révisé `bda5839` qui intègre les corrections L1-R1/L1-R2 de la revue Codex) : dépend des modèles du Lot 1 et de la connexion Drive du Lot 2. Même écart assumé avec SPEC §12 que le Lot 2 ; à rebaser sur `origin/main` après fusion des lots précédents. |
| **État module** | IN_BUILD (drapeau absent ⇒ page 404, routes 404, lien masqué) |
| **Autorisation** | Lot 3 ouvert sur instruction de Nizar (« Lot 3 », 30/10/2026). Aucun push, aucune PR, aucun appel réel à Google, aucune activation. |

## Périmètre livré (liste fermée)

| Fichier | Nature |
|---------|--------|
| `src/lib/worksite-photos/photo-storage.port.ts` | Port `PhotoStoragePort` (préallocation d'identifiant, dossiers, création idempotente `created:false` sur 409, lecture, flux, corbeille, suppression) et adaptateur `DrivePhotoStorage` composant connexion chiffrée + client REST + dossiers par identité ; aucune URL Drive ne sort |
| `src/lib/worksite-photos/photo.service.ts` | **Autorité métier** : `resolveActor` (acteur relu en base, rôle effectif = fiche employé, visibilité D8), `authorizeUploadTarget` (404/409 avant corps), `uploadPhoto` (étapes 3 à 9 du §7.1, CAS partout, bail, reprise après bail expiré, rejeu `COMMITTED`, `UPLOAD_IN_PROGRESS` / `UPLOAD_SUPERSEDED` / `UPLOAD_ABORTED`, jamais de suppression Drive — D18 ; **dans la transaction : relecture de l'autorité courante de l'acteur et de sa visibilité sur le chantier, sous verrous** ; **horodatage de création posé une seule fois** ; **identité du dossier au jour civil de l'entreprise**), `listUploadContext`, `listPhotos` (curseur), `openPhotoFile` (audit `ACCESS_GRANTED`/`ACCESS_DENIED` avant flux) ; surface base structurelle `PhotoDb` |
| `src/lib/worksite-photos/photo.prisma-adapter.ts` | Adaptateur Prisma : filtres de visibilité identiques aux pages `/chantiers` (EMPLOYEE via `employeeAssignments`, TEAM_LEADER via équipes dirigées actives, administrateurs toute l'entreprise), `INSERT` idempotent (P2002 ⇒ `null`), CAS en `updateMany` conditionnels (dont `driveFileCreatedAt IS NULL`), verrous `FOR SHARE` dans la transaction sur le chantier, l'engin, **le compte, l'entreprise, la fiche employé, les équipes que la fiche dirige dans l'entreprise, et les lignes d'affectation qui ouvrent la visibilité**, dans cet ordre fixe, puis relecture des équipes actives encore dirigées par la fiche (READ COMMITTED, 10 s) |
| `src/lib/worksite-photos/photo.api.ts` | Handlers testables : enveloppe commune (drapeau 404, origine des mutations, erreurs `{ code, error }` sans détail interne, `private, no-store`), lecture multipart **bornée sur le flux réel** (`file` + `payload` seuls, 32 Kio de payload), upload (pré-autorisation puis lecture, `Idempotency-Replayed`, 201), liste, proxy (nosniff, CSP `sandbox`, `Content-Length` = taille vérifiée à l'upload) |
| `src/lib/worksite-photos/photo.deps.ts` | Composition de production (session, Prisma, stockage Drive), un seul point d'assemblage |
| `src/app/api/worksite-photos/worksites/[worksiteId]/trucks/[truckId]/route.ts` (POST), `…/context/route.ts`, `…/route.ts` (GET liste), `…/[id]/file/route.ts` | Wrappers fins |
| `src/lib/worksite-photos/client/compress-image.ts` | Compression navigateur (bord long 2048, qualité 0,82 ; replis 0,7 puis 1600 px ; orientation EXIF appliquée au décodage, EXIF retiré), SHA-256 client, partie pure testable sans DOM |
| `src/components/worksite-photos/PhotosEnginsView.tsx` | Vue cliente : chantier / engin / phase, prise de vue `capture="environment"`, compression puis envoi multipart avec **clé d'idempotence conservée jusqu'au 201** (« Réessayer » rejoue la même clé), gestion `UPLOAD_IN_PROGRESS` / `UPLOAD_ABORTED`, liste par chantier sélectionné avec statuts et vignettes via le proxy |
| `src/app/(dashboard)/photos-engins/page.tsx` | Page serveur : 404 sans drapeau, contexte + premières photos, redirections sur refus |
| `src/lib/navigation/nav-config.ts`, `src/components/layout/Sidebar.tsx`, `src/components/layout/MobileNav.tsx`, `src/app/(dashboard)/layout.tsx` | `withWorksitePhotosNavItem` (après « Chantiers », affichage seulement), visibilité calculée côté serveur (drapeau + rôle interne + société) |
| `src/lib/worksite-photos/drive/drive-api.client.ts` | `downloadFile` (`alt=media`, flux ; longueur ignorée si le corps est encodé) |
| `src/lib/worksite-photos/drive/drive-folders.ts`, `src/lib/worksite-photos/photo.domain.ts` | Contrat du dossier du jour : `civilDayDate(dayLabel)` fournit l'identité DATE du même jour civil que le libellé ; le résolveur **refuse** une identité incohérente avec le libellé |
| `next.config.ts` | `NetworkOnly` pour `/photos-engins`, `/api/worksite-photos`, `/api/auth/drive` (jamais de cache service worker) |
| `tests/worksite-photos/photo-service.test.ts` (23), `photo-api.test.ts` (8), `compress-image.test.ts` (3), `photos-engins-view.render.test.tsx` (2), `tests/navigation/nav-worksite-photos.test.ts` (3), `drive-api-client.test.ts` (+1), `drive-folders.test.ts` (+1) | 41 tests en base et stockage factices (le CAS factice honore `driveFileCreatedAt: null` et reproduit le déclencheur d'immutabilité) |
| `tests/worksite-photos/photo-service.pg.test.ts` (10) | **Service × adaptateur Prisma × PostgreSQL jetable** : publication nominale et contrainte différée, reprise avec horodatage posé, révocations entre admission et publication (affectation, compte, équipe retirée du chantier, **équipe désactivée, chef remplacé**), courses révocation / publication sous verrou `FOR SHARE` (retrait d'affectation, **désactivation d'équipe, changement de chef avec `lock_timeout` 700 ms**) |
| `package.json` | scripts `test:worksite-photos`, `test:navigation` et `test:worksite-photos:pg` (migration puis service, séquentiels) étendus ; **aucune dépendance ajoutée** |

Hors de ce lot : API agent Hermes et contrat v1 (Lot 4), crons (alerte J+7, abandon, réconciliation, purge), `vercel.json` et runbooks (Lot 5), recette et activation (Lot 6). Aucune suppression de photo n'existe en V1 (D9) ; `trash`/`delete` du port ne sont appelés par aucun code de ce lot.

## Comportements garantis par les tests

- **Droits** : CLIENT, session sans entreprise, compte inactif, rôle de session différent du rôle effectif ⇒ 401/403 ; employé = chantiers affectés, chef d'équipe = chantiers de ses équipes, administrateurs = tous ; chantier d'un autre tenant ou non visible ⇒ 404 ; archivé ⇒ 409 ; engin absent / autre tenant ⇒ 404, inactif ⇒ 409 ; **la pré-autorisation refusée ne consomme aucun octet du corps** (flux instrumenté).
- **Autorité relue en transaction** : compte désactivé ⇒ 401 ; entreprise ou fiche désactivée, rôle changé, fiche supprimée ⇒ 403 ; affectation de l'ouvrier ou équipe du chef retirée ⇒ 404 ; dans tous ces cas aucune photo, réservation `ABANDONED` par CAS, aucune suppression Drive ; sans révocation la photo porte le nom relu. Pour un chef d'équipe : équipe désactivée ou chef remplacé avant la lecture verrouillée ⇒ 404. Sur PostgreSQL : une révocation lancée pendant la transaction (retrait d'affectation, désactivation d'équipe, changement de chef) **attend le verrou** et ne s'applique qu'après la publication.
- **Réservation** : une clé ⇒ une réservation, un identifiant Drive, une photo ; rejeu de la même clé ⇒ même reçu, aucun appel au stockage, `Idempotency-Replayed: true` ; autre contenu sous la même clé ⇒ 409 `IDEMPOTENCY_CONFLICT` ; bail détenu ⇒ 409 `UPLOAD_IN_PROGRESS` (+ `Retry-After`) sans appel au stockage ; bail expiré ⇒ reprise par CAS (génération + 1), même identifiant Drive, 409 fournisseur ⇒ contrôle taille/md5 du fichier existant puis publication, **`driveFileCreatedAt` déjà posé conservé** (vérifié contre le déclencheur réel) ; génération perdue pendant la création ⇒ aucun horodatage écrit ; échec du stockage avant rattachement ⇒ **bail libéré** (le nouvel essai de la même clé reprend aussitôt) ; contenu inattendu sous notre identifiant ⇒ `ABANDONED` + 409 `UPLOAD_ABORTED` ; `ABANDONED`/`CLEANING`/`CLOSED` ⇒ 409 `UPLOAD_ABORTED` ; refus métier dans la transaction ⇒ `ABANDONED` ; CAS de commit perdu ⇒ 409 `UPLOAD_SUPERSEDED` ; **aucun `trash`/`delete` sur Drive dans tous ces chemins**.
- **Fichier** : payload incohérent avec la route, clé absente, type non image, checksum client faux ⇒ refus **avant** toute réservation ; multipart avec champ manquant/doublé/inconnu, non multipart ⇒ 400 ; fichier au-delà du plafond ⇒ 413 pendant la lecture ; PDF renommé ⇒ 415.
- **Lectures** : liste limitée aux chantiers visibles, paginée, sans identifiant Drive ; proxy avec `nosniff`, CSP `sandbox`, `private, no-store`, `Content-Length` = taille enregistrée ; photo d'un chantier non visible ou `DELETED` ⇒ 404 + événement `ACCESS_DENIED`.
- **Jour civil** : identité DATE et libellé du dossier désignent le même jour dans le fuseau de l'entreprise (23 h 30 UTC ⇒ lendemain à Paris, passage heure d'été/hiver, décalage négatif) ; le résolveur refuse une incohérence avant tout appel.
- **Navigation** : lien inséré après « Chantiers » seulement si `visible === true`, idempotent, parité stricte Sidebar / MobileNav préservée (suite `test:navigation` 27/27).

## Variables d'environnement lues par ce lot (documentées, non créées)

`PLANIFICATOR_WORKSITE_PHOTOS_ENABLED` (drapeau), `WORKSITE_PHOTOS_MAX_BYTES` (défaut 3 Mio, plafond dur 4 Mio), `WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES` (défaut 15, bornes 5–60), `PLANIFICATOR_TRUSTED_ORIGINS` (coque Capacitor), plus celles du Lot 2 pour l'accès Drive.

## Décisions appliquées

- **D3** : compression client puis proxy serveur ≤ 4 Mio ; le serveur compte le flux réel, `Content-Length` n'est jamais une preuve.
- **D8** : visibilité des chantiers par les filtres d'affectation existants ; relue à chaque envoi et à chaque ouverture de fichier.
- **D15 / D16 / D17 / D18** : identifiant Drive préalloué, bail et CAS, états de réservation, le chemin de requête ne supprime jamais sur Drive.
- **R3 (revue Codex, Lot 0)** : pré-autorisation sur les paramètres de route avant lecture du corps ; test de non-consommation du flux.

## Preuves d'exécution (2026-10-30, poste local)

| Vérification | Résultat |
|--------------|----------|
| `npm run test:worksite-photos` (Lots 1 + 2 + 3) | **124/124** (après rebase sur le Lot 2 révisé) |
| `npm run test:worksite-photos:pg` sur base `postgres:17` jetable recréée (84 migrations) | **3 + 6 + 10 = 19/19** (Lot 1 : 46 sondes et rollback ; Lot 2 : protocole de connexion Drive ; Lot 3 : service × adaptateur × déclencheurs × verrous) |
| Mêmes tests sur l'adaptateur de la révision 2 (sans verrou `teams`) | les deux courses d'équipe **échouent** : les tests détectent le défaut |
| Sonde Codex `team-revocation.pg.probe.ts` rejouée | son 7ᵉ scénario, qui affirmait le défaut, échoue désormais sur `55P03 lock timeout` : la désactivation d'équipe est bloquée par le verrou |
| `npm run test:navigation` (parité + lien Photos engins) | **27/27** |
| `npm run test:vehicules:v3` (façades HTTP partagées du Lot 1) | **148 + 9**, vertes |
| `tsc --noEmit` projet entier | aucune erreur du lot (2 erreurs d'environnement préexistantes : types `jsdom`, `tough-cookie`) |
| Revue de code automatisée (effort high) | 10 constats, tous corrigés (§Revue) |
| Revue indépendante Codex (`REVUE-CODEX-LOT-3.md`) | 3 constats, tous corrigés et testés, dont sur PostgreSQL (§Revue) |
| Relecture Codex de la révision 2 (`REVUE-CODEX-LOT-3-REV2.md`) | L3-R2, L3-R3 et L3-R1 (employé) clos ; 1 constat restant L3R2-R1 (équipes du chef), corrigé en révision 3 (§Revue) |

Aucun appel réel à Google : stockage factice. L'adaptateur Prisma, les déclencheurs et les contraintes différées sont exercés contre PostgreSQL par `test:worksite-photos:pg` (base jetable **recréée à vide** avant chaque campagne : la chaîne laisse volontairement des lignes non supprimables).

## Revue

Revue de code automatisée sur le diff du lot : 10 constats, **tous corrigés** avant la relecture, tests rejoués ensuite :
1. un échec du stockage avant la transaction laissait le bail détenu : le nouvel essai de la même clé recevait `UPLOAD_IN_PROGRESS` jusqu'à la fin du TTL (15 min) alors qu'aucune tentative ne tournait ⇒ bail libéré sur échec avant rattachement (reprise idempotente par l'identifiant préalloué) ; testé ;
2. un contenu inattendu sous notre identifiant Drive était réessayable à l'infini ⇒ `ABANDONED` + 409 `UPLOAD_ABORTED` + événement ; testé ;
3. `Content-Length` du proxy repris de l'en-tête Drive (longueur du corps encodé si `Content-Encoding`) ⇒ taille vérifiée à l'upload ; `downloadFile` ignore la longueur d'un corps encodé ; testés ;
4. `listPhotos` énumérait jusqu'à 500 chantiers pour les administrateurs (photos au-delà invisibles) ⇒ filtre entreprise direct sans énumération ;
5. la liste ne suivait pas le chantier sélectionné ⇒ rechargement à la sélection ;
6. un échec du rafraîchissement après un 201 était présenté comme un échec d'envoi (risque de doublon) ⇒ message distinct ;
7. `filename*` laissait passer `' ( ) *` (RFC 5987) ⇒ échappés ;
8. `findEmployee` et `findTimezone` séquentiels ⇒ parallèles ;
9. commentaire JSDoc orphelin dans `nav-config.ts`, directives eslint mortes ⇒ retirés ;
10. révocations d'aperçu dupliquées dans la vue ⇒ un seul effet.

Points connus, assumés pour la V1 : ordre des verrous de la transaction (chantier, engin, compte, entreprise, fiche, affectations) et délai 10 s ; chaque vignette passe par le proxy audité (quelques requêtes par image) ; la liste affiche les 50 dernières photos du chantier sélectionné sans pagination côté UI (le curseur existe côté API) ; le lien de navigation n'apparaît qu'avec le drapeau serveur.

**Revue indépendante Codex** (`REVUE-CODEX-LOT-3.md`, CHANGES_REQUIRED sur `377581c`) : trois constats, vérifiés exacts et **corrigés** dans cette révision :
- **L3-R1** (bloquant) — la transaction ne relisait que le chantier et l'engin : un compte révoqué ou un ouvrier retiré du chantier après l'admission publiait encore. Correction : la même résolution d'autorité qu'à l'admission (`resolveActorRows`) est rejouée **dans la transaction** sur un lecteur qui verrouille `FOR SHARE` le compte, l'entreprise, la fiche employé et les affectations ouvrant la visibilité, puis la visibilité du chantier est relue ; refus ⇒ aucune photo, réservation `ABANDONED` par CAS, aucune suppression Drive. Tests : 5 sur doubles, 4 sur PostgreSQL (dont la course : la révocation attend le verrou).
- **L3-R2** (bloquant) — `driveFileCreatedAt` réécrit sans condition, interdit par le déclencheur d'immutabilité : une reprise après interruption échouait indéfiniment. Correction : CAS conditionné à `driveFileCreatedAt IS NULL` (0 ligne = déjà posé, la perte de génération reste détectée par le CAS de commit). Tests : double fidèle au déclencheur, et reprise réelle sur PostgreSQL avec horodatage préexistant conservé.
- **L3-R3** (majeur) — identité DATE du dossier tronquée en UTC alors que le libellé suit le fuseau de l'entreprise. Correction : `civilDayDate(dayLabel)` transmis au résolveur, qui refuse toute incohérence. Tests : sept instants (sonde Codex 23 h 30 UTC, été/hiver, décalage négatif, UTC).
- Les corrections du Lot 1 (L1-R1, L1-R2) sont intégrées dans la pile par rebase (Lot 1 `bda5839`, Lot 2 `92d48cb`). Lot 1 révisé : **GO Codex** (`REVUE-CODEX-LOT-1-REV2.md`).

**Relecture Codex de la révision 2** (`REVUE-CODEX-LOT-3-REV2.md`, CHANGES_REQUIRED sur `9d25c9b`) : un seul constat restant, vérifié exact et **corrigé** en révision 3 :
- **L3R2-R1** (P1) — les équipes qui donnent ses droits au chef n'étaient pas verrouillées : une désactivation d'équipe lancée après la lecture passait avant la publication. Correction : dans la transaction, après la fiche employé, `FOR SHARE` sur les lignes `teams` dirigées par cette fiche dans l'entreprise (actives ou non, ordre `id`), puis relecture des équipes **actives, encore dirigées par la fiche, de la même entreprise** ; ordre de verrouillage fixe compte → entreprise → fiche → équipes → affectations. Tests PostgreSQL : désactivation et changement de chef avant la lecture ⇒ 404 ; désactivation pendant la transaction ⇒ attend le COMMIT ; changement de chef pendant la transaction avec `lock_timeout` 700 ms ⇒ refusé par le délai, équipe inchangée. Les deux courses échouent sur l'adaptateur de la révision 2.

**Propagation de la révision du Lot 2** (revue Codex `REVUE-CODEX-LOT-2.md`, corrections L2-R1 à L2-R5 dans `faf2d2f`) : rebase sans conflit sur les fichiers Drive (`drive-api.client.ts`, `drive-folders.ts` fusionnés automatiquement ; seul `package.json` résolu à la main pour chaîner les trois tests PostgreSQL). Deux ajustements du Lot 3 en conséquence :
- messages publics des nouveaux codes `DRIVE_CONFLICT`, `DRIVE_OAUTH_MISCONFIGURED`, `DRIVE_OAUTH_PROTOCOL_ERROR` (`photo.api.ts`) ;
- `DRIVE_CONFLICT` avant le rattachement (409 non reconnu à la création du fichier, ou dossier distant incohérent) ⇒ réservation `ABANDONED`, événement `UPLOAD_ABORTED`, 409 `UPLOAD_ABORTED` (nouvelle prise de vue) au lieu de libérer le bail : un réessai de la même clé retomberait sur le même conflit. Aucune suppression Drive. Testé (`photo-service.test.ts`).
- Limite connue : un conflit persistant sur un **dossier** (objet incohérent sous l'identifiant réservé du dossier) refusera aussi les nouvelles clés pour ce chantier et ce jour jusqu'à intervention ; il est signalé par l'événement et relève de l'exploitation (Lot 5).

Relecture de Nizar à venir avant toute PR.

## Rollback

Drapeau absent ⇒ page 404, routes 404, lien masqué, aucune lecture Drive. Les tables viennent du Lot 1 (son `ROLLBACK.sql`) ; les photos déjà créées restent en base et sur Drive, inertes.
