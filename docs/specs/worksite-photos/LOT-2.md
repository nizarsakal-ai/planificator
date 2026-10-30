# SPEC-WORKSITE-PHOTOS-001 — Lot 2 — Connexion Google Drive

| Champ | Valeur |
|-------|--------|
| **SPEC / ADR** | SPEC-WORKSITE-PHOTOS-001 (Acceptée), ADR-PLAN-005 (Accepté) — sur `feat/worksite-photos-lot-0`, non fusionnée |
| **Lot** | 2 — connexion Drive : client REST en `fetch`, erreurs typées, tokens chiffrés et refresh, flux OAuth (démarrage, callback), déconnexion locale, résolution des dossiers par identité, carte Paramètres, tests en fetch factice. **Aucun upload de photo, aucune route d'écriture de photo, aucun cron.** |
| **Branche** | `feat/worksite-photos-lot-2`, **empilée sur `feat/worksite-photos-lot-1`** (révisé `bda5839`, GO Codex ; initialement `af68b5b`) : le lot dépend des modèles Prisma du Lot 1 non encore fusionnés. Écart assumé avec SPEC §12 (« branche depuis `origin/main` ») tant que le Lot 1 n'est pas fusionné ; à rebaser sur `origin/main` après fusion du Lot 1. |
| **État module** | IN_BUILD (drapeau absent ⇒ aucune route servie, carte Paramètres absente) |
| **Autorisation** | Lot 2 ouvert sur instruction de Nizar (« Lot 2 », 30/10/2026). Aucun push, aucune PR, aucune création d'accès Google, aucune activation. |

## Périmètre livré (liste fermée)

| Fichier | Nature |
|---------|--------|
| `src/lib/worksite-photos/drive/drive.errors.ts` | `DriveProviderError` (code stable, statut HTTP de nos routes, `retryable`), lecture de la raison Google sans message brut, mapping 401/403 (quota, rate limit, autre)/404/429/5xx ; **409 ⇒ `DRIVE_ID_EXISTS` seulement pour la collision d'identifiant reconnue, `DRIVE_CONFLICT` sinon** ; codes `DRIVE_OAUTH_MISCONFIGURED` et `DRIVE_OAUTH_PROTOCOL_ERROR` |
| `src/lib/worksite-photos/drive/drive-api.client.ts` | `DriveApiClient` + `FetchDriveApiClient` : `generateIds`, `createFolder` et `createFile` avec identifiant **imposé** (création idempotente, D15), `getFile`, `trashFile`, `deleteFile` ; multipart/related construit à la main ; jeton fourni par l'appelant, jamais journalisé |
| `src/lib/worksite-photos/drive/drive-connection.client.ts` | Tokens chiffrés AES-256-GCM (même module que Gmail), refresh avec marge 5 min, **publication du refresh et de toute mise en erreur par CAS sur la génération de connexion** (chiffré du refresh token, IV aléatoire : reconnexion et déconnexion l'invalident) ; refus du point de jeton **classés par code OAuth** (`invalid_grant` seul ⇒ `ERROR`), `withDriveAccess` (un seul refresh forcé sur 401), `storeDriveConnection`, `disconnectDriveLocally` (D16 : aucun appel réseau, aucune table Gmail dans la surface) |
| `src/lib/worksite-photos/drive/drive-oauth.ts` | Handlers testables, **autorité administrateur commune relue en base** (`resolveDriveAdmin` : compte, entreprise, rôle effectif = rôle de session, sous verrous `FOR SHARE` dans les transactions) : démarrage (nonce de 32 octets dans un cookie `HttpOnly; SameSite=Lax; Secure` limité à `/api/auth/drive`, 10 min ; `state` HMAC v2 portant l'empreinte du nonce, l'entreprise, l'auteur, l'émission et l'échéance ; scopes `drive.file` + `userinfo.email`, `offline` + `consent`), callback (state signé non expiré, **cookie du navigateur initiateur**, **session courante = auteur et entreprise du state**, **consommation à usage unique** sous verrou consultatif avant tout échange, échange hors transaction, scope et `refresh_token` exigés, **autorité relue à la persistance**, stockage, événement `DRIVE_CONNECTED` avec e-mail haché ; cookie effacé à chaque fin), déconnexion (POST, origine contrôlée, **autorité relue dans la même transaction que l'effacement**, locale, événement `DRIVE_DISCONNECTED`) |
| `src/lib/worksite-photos/drive/drive-folders.ts` | Résolution racine → chantier → jour **par identité** (`companyId`, `worksiteId`, `day`), identifiant de dossier préalloué, `createIfAbsent` (ON CONFLICT), 409 Drive = existant, 404 sur dossier `CREATED` ⇒ nouvelle réservation, libellé figé à la création, racine mémorisée sur la connexion |
| `src/lib/worksite-photos/drive/drive-folders.prisma-adapter.ts` | Adaptateur Prisma du port (P2002 ⇒ `null`) |
| `src/app/api/auth/drive/route.ts`, `src/app/api/auth/drive/callback/route.ts`, `src/app/api/worksite-photos/drive/disconnect/route.ts` | Wrappers fins |
| `src/components/parametres/WorksitePhotosDriveCard.tsx` + `src/app/(dashboard)/parametres/page.tsx` | Carte Paramètres (connecter, reconnecter après `ERROR`, déconnecter localement avec avertissement Gmail), affichée seulement drapeau actif ; la page lit la connexion uniquement si le drapeau est actif |
| `tests/worksite-photos/drive-api-client.test.ts` (5), `drive-connection.test.ts` (14), `drive-oauth.test.ts` (16), `drive-folders.test.ts` (9) | 44 tests en fetch factice et base factice |
| `tests/worksite-photos/drive-oauth.pg.test.ts` (6) | **PostgreSQL jetable, vrai Prisma, vrai chiffrement (clé de test), Google factice** : double callback concurrent, révocation pendant l'échange, déconnexion par session périmée, refresh A contre reconnexion B, `invalid_grant` tardif, déconnexion pendant le refresh |
| `package.json` | scripts `test:worksite-photos` et `test:worksite-photos:pg` (migration puis connexion Drive) étendus ; **aucune dépendance ajoutée** |

Hors de ce lot : upload et réservation (Lot 3), API agent (Lot 4), crons et runbooks (Lot 5). Le port `DriveFoldersDb.createIfAbsent` sera exercé contre PostgreSQL par les tests du Lot 3 (flux d'upload complet).

## Variables d'environnement lues par ce lot (documentées, non créées)

`PLANIFICATOR_WORKSITE_PHOTOS_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (client OAuth **partagé** avec Gmail), `DRIVE_OAUTH_REDIRECT_URI` (nouvelle), `CRON_SECRET` (signature HMAC du `state`, comme Gmail), `GMAIL_TOKEN_ENCRYPTION_KEY` (chiffrement des tokens, nom historique), `NEXTAUTH_URL` (redirections vers Paramètres), `PLANIFICATOR_TRUSTED_ORIGINS` (déconnexion depuis la coque Capacitor).

Prérequis Google Cloud **à faire par Nizar avant activation** : API Drive activée sur le projet existant, URI `…/api/auth/drive/callback` ajoutée au client OAuth, écran de consentement **en production** (sinon refresh tokens expirant à 7 jours).

## Décisions appliquées

- **D2 / D16** : OAuth utilisateur `drive.file` ; déconnexion locale, aucun appel au point de révocation Google ; révocation globale (`invalid_grant`) ⇒ `ERROR` + reconnexion depuis Paramètres.
- **D15** : identifiants préalloués pour les dossiers (et, au Lot 3, pour les fichiers) ; 409 = déjà créé.
- **R2 (revue Codex)** : la surface base de la connexion Drive ne contient aucune table Gmail ; test de non-régression : la déconnexion n'écrit que sur `worksite_photo_drive_connections`.

## Preuves d'exécution (2026-10-30, poste local)

| Vérification | Résultat |
|--------------|----------|
| `node --test` sur les 4 fichiers du lot (5 + 14 + 16 + 9 après revue Codex) | **44/44** |
| `npm run test:worksite-photos` (Lot 1 révisé + Lot 2) | **86/86** |
| `npm run test:worksite-photos:pg` sur base `postgres:17` jetable recréée (84 migrations) | **3 + 6 = 9/9** (Lot 1 : sondes et rollback ; Lot 2 : protocole de connexion) |
| `tsc --noEmit` ciblé sur les fichiers du lot, les routes, la carte et la page Paramètres | aucune erreur (2 erreurs d'environnement préexistantes : types `jsdom`, `tough-cookie`) |
| `test:vehicules:v3` (148 + 9), `test:navigation` (24) | **vertes** |
| Revue de code automatisée | 4 constats, tous corrigés (§Revue) |

Aucun appel réel à Google n'a été effectué : tous les tests utilisent un `fetch` factice. La recette avec le vrai compte Galyaevents1 (consentement, scope, refresh) relève du Lot 6 en préproduction.

## Revue

Revue de code automatisée (effort high) sur le diff du lot : 4 constats, **tous corrigés** avant la relecture, tests rejoués ensuite :
1. le callback OAuth faisait confiance au `state` signé sans revérifier l'administrateur au moment de l'effet : relecture en base (actif, ADMIN/SUPER_ADMIN, même entreprise ; SUPER_ADMIN global admis avec l'entreprise explicite du state) **avant** l'échange du code, `reason=forbidden` sinon ; testé (désactivé, rétrogradé, autre entreprise, inexistant) ;
2. en-tête `Content-Length` posé à la main sur le multipart : retiré, la longueur est laissée à `fetch` ;
3. trois `files.get` par upload en régime établi : chemin rapide sur le dossier du jour (un seul contrôle), chaîne complète seulement s'il manque ; testé (invalidation sur suppression manuelle) ;
4. ce compte rendu renvoyait au commit au lieu de donner les preuves : chiffres renseignés.

**Revue indépendante Codex** (`REVUE-CODEX-LOT-2.md`, CHANGES_REQUIRED sur `92d48cb`) : cinq constats, vérifiés exacts et **corrigés** :
- **L2-R1** (P1) — state ni lié au navigateur, ni expirant, ni consommé ; nonce `Math.random`. Correction : nonce `randomBytes(32)` dans un cookie `HttpOnly; SameSite=Lax; Secure` limité au chemin du flux, state signé portant son empreinte SHA-256 et une échéance de 10 min (tolérance d'émission 60 s), session courante exigée identique à l'auteur et à l'entreprise du state, **consommation à usage unique côté serveur** : dans une transaction, `pg_advisory_xact_lock` sur l'empreinte puis absence d'un événement `DRIVE_OAUTH_STATE_CONSUMED` puis insertion de cet événement — **aucune table ajoutée**, le schéma du Lot 1 (GO) est inchangé. Tout refus avant l'échange de code. Le parcours se fait depuis un navigateur ; la coque Capacitor n'est pas prise en charge (Google refuse l'OAuth en WebView embarquée).
- **L2-R2** (P1) — déconnexion et démarrage fondés sur le seul JWT ; callback sans relecture à la persistance. Correction : `resolveDriveAdmin` (compte actif, entreprise active, rôle effectif administrateur égal au rôle de session, fiche employé de l'entreprise prioritaire) appelée au démarrage, dans la transaction de consommation du callback, dans la transaction de persistance après l'échange réseau (aucun appel Google sous transaction), et dans la transaction de déconnexion, sous verrous `FOR SHARE`.
- **L2-R3** (P1) — un refresh de l'ancienne connexion pouvait écraser la nouvelle. Correction : CAS `{ companyId, refreshToken: <chiffré lu>, status: ACTIVE }` pour la publication du jeton et pour la mise en `ERROR` ; CAS perdu ⇒ le jeton obtenu est jeté, seul le jeton valide de la connexion courante peut être rendu, sinon refus réessayable. Repose sur l'IV aléatoire de `src/lib/encryption.ts` (vérifié).
- **L2-R4** (P2) — tout 400/401 du point de jeton traité comme `invalid_grant`. Correction : classement par code OAuth (`invalid_grant` ⇒ `ERROR` ; `invalid_client`/`unauthorized_client` ⇒ `DRIVE_OAUTH_MISCONFIGURED` ; autres 4xx, réponse illisible, 200 sans jeton ⇒ `DRIVE_OAUTH_PROTOCOL_ERROR` ; ces deux-là non réessayables, statut conservé, incident tracé ; 429/5xx réessayables).
- **L2-R5** (P2) — tout 409 accepté comme création. Correction : `DRIVE_ID_EXISTS` seulement si la raison reconnue est la collision d'identifiant, `DRIVE_CONFLICT` sinon ; sur collision reconnue, `ensureFolder` contrôle l'objet distant (dossier, hors corbeille, bon parent) avant de marquer `CREATED`.

Les sondes Codex (`oauth-probes.ts`, `refresh-probes.ts`) ne s'exécutent plus sur ce code : leurs bases factices reprennent l'ancienne surface (sans `company`, `employee`, `updateMany`, `$transaction`). Chacun de leurs scénarios est couvert par les tests ci-dessus. Relecture de Nizar à venir avant toute PR.

## Rollback

Drapeau absent ⇒ aucune route servie, carte masquée. Les tables viennent du Lot 1 (son `ROLLBACK.sql`). Une connexion déjà enregistrée reste chiffrée en base et inerte.
