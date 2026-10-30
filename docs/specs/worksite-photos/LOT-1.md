# SPEC-WORKSITE-PHOTOS-001 — Lot 1 — Schéma, migration, domaine pur, helpers partagés

| Champ | Valeur |
|-------|--------|
| **SPEC / ADR** | SPEC-WORKSITE-PHOTOS-001 (Acceptée le 30/10/2026, module SPECIFIED) ; ADR-PLAN-005 (Accepté). Les deux documents sont sur la branche `feat/worksite-photos-lot-0`, non encore fusionnée : ce lot ne les reproduit pas. |
| **Lot** | 1 — fondation : 6 enums, 5 tables `worksite_photo*` / `worksite_truck_photos`, colonne `worksites.clientContact`, valeur `NotificationType.WORKSITE_PHOTO_UNSENT`, contraintes CHECK, déclencheurs, drapeau, domaine pur, helpers HTTP/fichiers partagés, tests. **Aucune route, aucune page, aucun appel Drive, aucune donnée.** |
| **Branche** | `feat/worksite-photos-lot-1`, créée depuis `origin/main` = `039477c`, worktree dédié |
| **État module** | IN_BUILD (non exposé : drapeau absent ⇒ rien n'est servi ; aucune route n'existe encore) |
| **Autorisation** | Lot 1 ouvert sur instruction de Nizar (« REPREND », 30/10/2026) après acceptation formelle de l'ADR et de la SPEC. Aucun push, aucune PR, aucune migration sur préproduction/production, aucune activation. |

## Périmètre livré (liste fermée)

| Fichier | Nature |
|---------|--------|
| `prisma/schema.prisma` | +198 lignes, 0 supprimée : section « PHOTOS D'ENGINS » (6 enums, 5 modèles), `Worksite.clientContact String?`, relations inverses `Worksite.truckPhotos`, `Truck.worksitePhotos`, `Company.worksitePhoto*`, valeur `NotificationType.WORKSITE_PHOTO_UNSENT` |
| `prisma/migrations/20261030180000_worksite_photos_lot1/migration.sql` | DDL généré par `prisma migrate diff` (datamodel `origin/main` → datamodel du lot), **relu et borné**, complété de 7 contraintes CHECK, 4 fonctions et 5 déclencheurs (cycle PENDING→SENT→DELETED, insertion PENDING seule, preuve d'envoi complète et figée, horodatages monotones, machine d'états des réservations, **réservation rattachée à une photo jamais abandonnée ni nettoyée**, journal en ajout seul, **contrainte différée de publication** dans les deux sens : une photo n'existe qu'avec SA réservation COMMITTED — même identité, fichier, chantier, engin, auteur, ligne verrouillée `FOR SHARE` — et COMMITTED exige la photo rattachée en fin de transaction), index unique d'identité des dossiers `NULLS NOT DISTINCT`, assertions finales. La valeur d'enum est ajoutée hors transaction (patron V3). |
| `prisma/migrations/20261030180000_worksite_photos_lot1/ROLLBACK.sql` | Retrait borné aux objets du lot, **non exécuté par Prisma** ; **vérifie sous verrou (`ACCESS EXCLUSIVE` sur les cinq tables, `SHARE ROW EXCLUSIVE` sur `worksites`) qu'aucune ligne n'existe et qu'aucun `clientContact` n'est renseigné, et REFUSE sinon** (transaction annulée, entrée `_prisma_migrations` conservée) ; repli normal = drapeau absent |
| `src/lib/worksite-photos/feature-flag.ts` | `PLANIFICATOR_WORKSITE_PHOTOS_ENABLED`, `WORKSITE_PHOTOS_AGENT_ENABLED` (`=== "true"`, agent ⇒ module) |
| `src/lib/worksite-photos/photo.domain.ts` | Domaine pur : erreur typée, transitions photo et réservation (dont états non réutilisables), bornes de configuration (§8), validation de fichier (magic bytes, extension, type déclaré, plafond dur 4 Mio, SHA-256 client), nommage Drive (libellés, `~id6`, jour civil, nom de fichier, chemin), empreinte de requête, schémas Zod stricts (`payload`, `Idempotency-Key`, `mark-sent` avec `transportKind`, `clientContact`, pagination ≤ 100), preuve canonique, sélections des crons (J+7, purge, bail, reprise de suppression, surveillance durable sans clôture, alerte unique), filtre anti-fuite du journal |
| `src/lib/http/guard-error.ts`, `src/lib/http/request-origin.ts`, `src/lib/http/bounded-body.ts` | Helpers **déplacés** depuis Véhicules avec refus injectable ; comportement inchangé |
| `src/lib/files/magic-mime.ts` | `detectMagicMime` déplacé depuis `vehicules/v3/document-domain.ts` |
| `src/lib/vehicules/request-origin.ts`, `src/lib/vehicules/v3/v3-http.ts`, `src/lib/vehicules/v3/document-domain.ts` | Façades : même API, même `MileageDomainError` ; délèguent aux helpers partagés |
| `tests/worksite-photos/photo-domain.test.ts` (22), `http-helpers.test.ts` (10), `migration-sql.test.ts` (10) | Tests unitaires sans base (contrat statique de la migration et du rollback, dont la garde de vacuité avant tout DROP) |
| `tests/worksite-photos/migration.pg.test.ts` + `sql/lot1-probes.sql` | Base jetable : 46 sondes refusées **avec contrôle du nom de la contrainte qui refuse** (CHECK, déclencheurs, FK composites cross-tenant, unicité des dossiers, cohérence photo/réservation), rollback à vide puis ré-application, rollback **refusé** sur données (dossier, `clientContact`, réservation) sans rien détruire |
| `package.json` | scripts `test:worksite-photos`, `test:worksite-photos:pg` ; **aucune dépendance ajoutée** |

Hors de ce lot (lots suivants) : connexion Drive et client `fetch` (Lot 2), route d'upload, service, réservation et UI (Lot 3), API agent (Lot 4), crons et runbooks (Lot 5).

## Variables d'environnement lues par ce lot (documentées, non créées)

`PLANIFICATOR_WORKSITE_PHOTOS_ENABLED`, `WORKSITE_PHOTOS_AGENT_ENABLED`, `WORKSITE_PHOTOS_MAX_BYTES` (plafond dur 4 Mio, défaut 3 Mio), `WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES` [5, 60] = 15, `WORKSITE_PHOTOS_ABANDON_QUIET_HOURS` [1, 72] = 24, `WORKSITE_PHOTOS_UNSENT_ALERT_DAYS` [1, 365] = 7, `WORKSITE_PHOTOS_PURGE_AFTER_DAYS` [1, 30] = 30. Aucune n'a d'effet tant qu'aucune route n'existe.

## Preuves d'exécution (2026-10-30, poste local)

Environnement : conteneur Docker `postgres:17` jetable (`server_version_num` 170011), base `planificator_lot1` + base shadow ; Prisma 5.22.0 ; Node 22.

| Vérification | Résultat |
|--------------|----------|
| `prisma migrate deploy` : 83 migrations existantes puis `20261030180000_worksite_photos_lot1` | **OK** ; second `deploy` ⇒ « No pending migrations to apply » |
| `prisma migrate diff --from-migrations --to-schema-datamodel` après le lot | **OK** : uniquement la dérive préexistante de `origin/main` (processed_gmail_messages, renommages d'index, vehicle_tours / vehicle_tour_stops, vehicle_cartography_cache) ; **0** ligne `worksite_photo*` |
| 46 sondes SQL (insertion hors PENDING, PENDING→DELETED, SENT sans preuve ou preuve vide, `transportKind` hors motif, altération de preuve après SENT/DELETED, retour SENT→PENDING, suppression SQL, journal modifié, engin d'un autre tenant, événement cross-tenant, réservation réutilisée depuis ABANDONED, ABANDONED→CLOSED sans CLEANING, clôture OPERATOR sans motif, génération décroissante, états terminaux, doublons de dossiers racine/chantier/jour, jour sans chantier, suppression d'un chantier référencé ; **L1-R1** : abandon d'une réservation rattachée, scénario UPLOADING + photo → ABANDONED → CLEANING, photo vers RESERVED / UPLOADING / CLOSED, COMMITTED sans photo, `driveFileId`, `id` et auteur divergents ; publications valides acceptées au contrôle différé rendu immédiat) | **46/46 refusées**, chaque refus par la contrainte attendue |
| `ROLLBACK.sql` à vide puis `migrate deploy` puis sondes | **OK** |
| `ROLLBACK.sql` avec un dossier Drive, puis un `clientContact`, puis une réservation en base | **refusé trois fois**, tables et entrée `_prisma_migrations` intactes |
| `npm run test:worksite-photos` | **42/42** |
| `npm run test:worksite-photos:pg` | **3/3** (base jetable `postgres:17`, 84 migrations) |
| `npm run test:vehicules` (219 + 178 + 148 + 9) et `test:vehicules:v3` | **tous verts** après déplacement des helpers |
| `test:navigation` 24, `test:security:hotfix` 19, `test:acquisition:flags` 165, `test:agent-gateway` 91 | **verts** |
| `test:chantiers` | 60 verts ; **4 à 5 échecs préexistants** du test « T-CORE-5 — garde de périmètre contre BASE_SHA figé » (lot Chantiers antérieur, échoue déjà sur `origin/main` : 4 échecs à l'identique sans ce lot) |
| `tsc --noEmit` | aucune erreur sur les fichiers du lot ni sur les façades Véhicules ; 2 erreurs préexistantes d'environnement (types `jsdom`, `tough-cookie` absents) |
| Revue de code | voir §Revue ci-dessous |

## Revue

Revue de code automatisée (effort high) sur le diff du lot : 5 constats, **tous corrigés** avant la relecture, tests rejoués ensuite :
1. compteurs de tests et de migrations erronés dans ce compte rendu ;
2. clause CHECK inatteignable (`closeReason = 'FILE_DELETED'`) dans la contrainte des réservations, retirée ;
3. cas « date d'abandon inconnue » de la surveillance non testé : cadence horaire conservée (côté sûr) et testée ;
4. helpers HTTP partagés non fail-closed face à un `reject` fourni qui ne lève pas : refus forcé par `HttpGuardError`, testé ;
5. SHA-256 client mal formé renvoyait `PHOTO_CHECKSUM_MISMATCH` au lieu de `INVALID_PAYLOAD` : harmonisé avec le schéma amont.

**Revue indépendante Codex** (`REVUE-CODEX-LOT-1.md`, CHANGES_REQUIRED sur `af68b5b`) : deux constats, vérifiés exacts et **corrigés** dans la révision du lot :
- **L1-R1** (bloquant) — la liaison photo/réservation n'excluait pas un fichier rattaché du nettoyage (photo insérée sur une réservation UPLOADING puis ABANDONED → CLEANING acceptés). Correction : garde immédiate (`worksite_photo_upload_reservations_attached_photo_check` : une réservation rattachée ne quitte pas COMMITTED) + contrainte différée de publication (`worksite_truck_photos_reservation_consistency_check` : la photo exige SA réservation COMMITTED avec identité, fichier, chantier, engin et auteur identiques, ligne verrouillée `FOR SHARE` ; `worksite_photo_upload_reservations_committed_photo_check` : COMMITTED exige la photo rattachée). 9 sondes ajoutées, reproduction exacte du scénario Codex refusée.
- **L1-R2** (majeur) — le rollback annonçait « sans données » sans le vérifier. Correction : verrous puis contrôle de vacuité des cinq tables et de `clientContact` AVANT tout DROP, refus explicite. Test PostgreSQL : refusé sur dossier, sur `clientContact`, sur réservation ; rien détruit ; ré-application à vide verte.
- Mineur — `expect_fail` acceptait toute exception : il vérifie désormais le SQLSTATE `23xxx` et le nom de la contrainte attendue.

Relecture de Nizar à venir avant toute PR.

## Rollback

- Niveau opérationnel : sans objet (aucun comportement exposé, drapeau absent).
- Retrait de schéma : `ROLLBACK.sql`, qui **refuse** s'il existe la moindre ligne dans les tables du lot ou un `clientContact` renseigné ; après mise en service, export du journal d'événements et arbitrage de l'Autorité Architecture.
- La valeur `NotificationType.WORKSITE_PHOTO_UNSENT` n'est pas retirée (PostgreSQL ne supprime pas une valeur d'enum) : inoffensive.

## Prérequis des lots suivants

PostgreSQL ≥ 15 confirmé (production déjà ≥ 17) ; écran de consentement OAuth Google en production, API Drive activée, URI de redirection ajoutée (Lot 2) ; `PLANIFICATOR_TRUSTED_ORIGINS` pour la coque Capacitor (Lot 3) ; arbitrage budget Vercel avant tout push.
