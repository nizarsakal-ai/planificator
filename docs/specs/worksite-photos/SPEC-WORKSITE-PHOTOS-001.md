# SPEC-WORKSITE-PHOTOS-001 — Photos d'engins sur chantier (Avant / Après)

| Champ | Valeur |
|-------|--------|
| **Statut** | **Accepté** — acceptation formelle par Nizar (Autorité Produit et Autorité Architecture) le 30/10/2026, après GO documentaire Codex (REVUE-CODEX-LOT-0-REV4-FINALE) ; **module SPECIFIED** (ES-001 §5.1). Lot 0 (gouvernance), aucune implémentation. Révision 4 : intègre les trois revues indépendantes Codex du Lot 0, voir §14 |
| **ADR** | [ADR-PLAN-005](../../adr/ADR-PLAN-005-photos-engins-drive-oauth-agent.md) |
| **Base** | `origin/main` = `039477c` (30/10/2026) ; design validé PLAN-WORKSITE-PHOTOS-001 v2 (revue Codex intégrée) |
| **Drapeau** | `PLANIFICATOR_WORKSITE_PHOTOS_ENABLED=true` (serveur, OFF par défaut, lu en un seul endroit : `src/lib/worksite-photos/feature-flag.ts`) |
| **Migration** | Une migration additive (Lot 1) ; **aucune** dans ce lot |
| **Norme** | ENGINEERING-STANDARD-001 ; PLAN-GOVERNANCE-001 (service = autorité, routes = wrappers fins, Zod strict serveur, `companyId` partout, TX atomiques) |

## 1. Périmètre

Inclus : prise et envoi d'une photo d'engin (`Truck`) par un ouvrier, rattachée à un chantier (`Worksite`), une phase (`BEFORE` / `AFTER`) et un auteur ; stockage sur le Google Drive de l'entreprise (`/Chantiers/<client>-<chantier>~<id6>/<yyyy-MM-dd>/`) sans URL publique ; consultation privée par proxy ; API versionnée pour l'agent externe Hermes (lister les photos en attente par chantier, renseigner le contact client, marquer envoyée, supprimer, lire le fichier) ; alerte aux administrateurs à J+7 sans envoi ; purge différée ; connexion Drive par un administrateur ; réconciliation après panne.

Exclus : lecture de la boîte mail et envoi aux clients (Hermes, brief séparé) ; liste blanche des destinataires (côté Hermes) ; suppression depuis l'interface (V1) ; file d'attente hors ligne (V2) ; conservation des originaux et des EXIF ; upload resumable direct (V2) ; détection automatique de l'engin (V2) ; migration vers l'Agent Gateway.

Drapeau OFF : aucune route `/api/worksite-photos*`, `/api/auth/drive*`, `/api/cron/worksite-photos-*`, aucune page `/photos-engins` n'est servie (404) ; entrée de menu absente ; comportement de production identique (tests de non-régression).

## 2. Décisions

D1 à D14 : **validées** par Nizar le 30/10/2026 (« Valider, Lot 0 »). D15 à D18 : proposées par les révisions 2 à 4, avis Codex favorable (revue de la révision 3), **validées** par Nizar le 30/10/2026 (« Valider D15-D18 ») sur la base de la révision 4.

| # | Décision | Valeur retenue |
|---|----------|----------------|
| D1 | « Engin » | Modèle `Truck` (table `trucks`), engins actifs uniquement (`active = true`) |
| D2 | Accès Drive | OAuth 2.0 compte `Galyaevents1@gmail.com`, scope `drive.file`, tokens chiffrés serveur (ADR-PLAN-005 §1) |
| D3 | Limite 4,5 Mo | Compression client + proxy borné 4 Mio ; resumable en V2 |
| D4 | Auth Hermes | Jeton machine dédié lié à une entreprise, derrière interface ; Gateway plus tard |
| D5 | Chemin Drive | `/Chantiers/<client>-<chantier>~<id6>/<yyyy-MM-dd>/` (suffixe anti-collision systématique) |
| D6 | `contact_client` | `Worksite.clientContact String?`, adresse e-mail validée (Zod `email`, ≤ 254) |
| D7 | Octets pour Hermes | Via l'API Planificator (proxy) ; Hermes n'a pas d'accès Drive propre |
| D8 | Chantiers photographiables | `EMPLOYEE` : chantiers où il est affecté ; `TEAM_LEADER` : chantiers où **son équipe** est affectée (filtre de la page détail `/chantiers/[id]` ; la page liste, plus large pour le chef, n'est **pas** reprise) ; `ADMIN`/`SUPER_ADMIN` : tous les chantiers non archivés ; élargissement = décision métier explicite |
| D9 | Suppression UI | Aucune en V1 — **remplacée par D21** ([LOT-ADMIN-REVIEW](LOT-ADMIN-REVIEW.md)), sur demande explicite de l'utilisateur du 31/10/2026, en revue |
| D10 | Alerte J+7 | Notification in-app aux administrateurs actifs, **une par chantier** (nombre de photos indiqué), chaque photo alertée une seule fois ; badge dans la page |
| D11 | Purge définitive | Cron, 30 jours après la mise en corbeille |
| D12 | Base de travail | Branche neuve depuis `origin/main` ; checkout local antérieur abandonné |
| D13 | Preuve d'envoi | `sentTo` + `sentMessageId` obligatoires pour `SENT`, vérifiés par CHECK SQL |
| D14 | Réservation d'upload | Table de réservation avant Drive + cron de réconciliation horaire |

| D15 | Identifiant Drive préalloué | `driveFileId` obtenu par `files.generateIds` **à la réservation** et réutilisé à chaque tentative : la création Drive devient idempotente (un second `files.create` avec le même `id` ⇒ 409, traité comme « déjà créé ») |
| D16 | Déconnexion Drive | **Locale** (effacement des tokens, statut `DISCONNECTED`), **sans** appel de révocation Google : le client OAuth est partagé avec Gmail et une révocation invaliderait aussi la connexion Gmail |
| D17 | Preuve d'envoi | `sentMessageId` = identifiant **accepté par le transport** (en-tête `Message-ID` du courriel accepté par le serveur SMTP, ou identifiant renvoyé par le fournisseur d'envoi) ; un hash local du courriel **n'est pas** accepté. **Frontière de confiance** : cette preuve est une **déclaration d'Hermes** ; Planificator en vérifie la forme et la conserve de façon immuable, il ne vérifie pas le transport ; le critère imposé à Hermes par le contrat agent est « réponse de succès du transport observée » (type de transport et référence transmis), et acceptation par le transport ne signifie pas livraison au destinataire |
| D18 | Réservation abandonnée non réutilisable | Une réservation `ABANDONED`/`CLEANING`/`CLOSED` ne peut plus porter de publication ; un rejeu de sa clé ⇒ 409 `UPLOAD_ABORTED`, le client repart avec une nouvelle clé et un nouvel identifiant Drive préalloué ; le chemin de requête ne supprime jamais de fichier Drive, seul le cron le fait depuis l'état exclusif `CLEANING` |

Point ouvert (sans effet sur le schéma) : valeur du bail de réservation (`WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES`, défaut 15, borné [5, 60]).

## 3. Modèle de données (migration additive, Lot 1)

Conventions : FK composites avec `companyId`, `onDelete: Restrict`, horodatages `Timestamptz(3)` à `clock_timestamp()`, snapshots de nom d'acteur, aucune URL persistée.

### 3.1 Enums
- `WorksitePhotoPhase { BEFORE, AFTER }`
- `WorksitePhotoStatus { PENDING, SENT, DELETED }` (en_attente → envoyée → supprimée)
- `NotificationType` : + `WORKSITE_PHOTO_UNSENT` (valeur ajoutée hors transaction, comme V3)

### 3.2 `worksite_truck_photos` (`WorksiteTruckPhoto`)
`id` (= `photoId` attribué **dès la réservation**, voir §3.3), `companyId`, `worksiteId`, `truckId`, `phase`, `status` (défaut `PENDING`), `driveFileId` (opaque), `drivePath` (snapshot du chemin logique), `originalFilename`, `mimeType` (`image/jpeg` | `image/png`, issu des magic bytes), `sizeBytes`, `sha256` (`Char(64)`), `takenAt?` (déclaré, informatif), `uploadedAt`, `uploadedById` (identifiant scalaire **sans FK**, patron `Task.createdById` : la suppression d'un employé par `deleteEmployeImpl` ne doit pas être bloquée), `uploadedByNameSnapshot`, `sentAt?`, `sentByAgent?`, `sentTo?`, `sentMessageId?`, `sentTransportKind?` (`smtp` | `provider:<nom>`, ≤ 64), `sentTransportRef?` (référence fournisseur facultative, ≤ 255), `trashRequestedAt?`, `trashedAt?`, `purgedAt?`, `unsentAlertedAt?`, `reservationId` (unique).

Relations : `worksite (worksiteId, companyId) → worksites (id, companyId)`, `truck (truckId, companyId) → trucks (id, companyId)`, `reservation (reservationId, companyId) → worksite_photo_upload_reservations (id, companyId)`, `company → companies (id)` ; toutes `Restrict`. La clé d'idempotence et l'empreinte de requête vivent **uniquement** sur la réservation (une seule source de vérité pour le rejeu).

Index et unicités : `@@unique([companyId, driveFileId])`, `@@unique([reservationId])`, `@@unique([id, companyId])`, `@@index([companyId, worksiteId, status, uploadedAt])`, `@@index([status, uploadedAt])`.

Contraintes SQL (preuve « complète » = `sentAt`, `sentTo`, `sentMessageId`, `sentTransportKind`, `sentByAgent` non nuls et non vides, chaînes testées par `length(btrim(x)) > 0` ; `sentTransportRef` facultatif mais figé avec la preuve) :
- `CHECK (status <> 'PENDING' OR (sentAt IS NULL AND sentTo IS NULL AND sentMessageId IS NULL AND sentTransportKind IS NULL AND sentTransportRef IS NULL AND sentByAgent IS NULL AND trashRequestedAt IS NULL AND trashedAt IS NULL AND purgedAt IS NULL))`
- `CHECK (status <> 'SENT' OR (preuve complète AND trashedAt IS NULL AND purgedAt IS NULL))`
- `CHECK (status <> 'DELETED' OR (preuve complète AND trashRequestedAt IS NOT NULL AND trashedAt IS NOT NULL))`
- `CHECK (trashRequestedAt IS NULL OR status IN ('SENT','DELETED'))`, `CHECK (trashedAt IS NULL OR trashedAt >= trashRequestedAt)`, `CHECK (purgedAt IS NULL OR purgedAt >= trashedAt)`. Aucun ordre imposé entre `sentAt` et `uploadedAt` (envoi déclaré rétrospectivement possible).
- Trigger `BEFORE INSERT` : `status = 'PENDING'` obligatoire (toute insertion directe en `SENT`/`DELETED` refusée).
- Trigger `BEFORE UPDATE` : transitions autorisées `PENDING→SENT`, `SENT→DELETED` uniquement ; `driveFileId`, `sha256`, `worksiteId`, `truckId`, `phase`, `uploadedById`, `reservationId` figés après insertion ; **`sentAt`, `sentTo`, `sentMessageId`, `sentTransportKind`, `sentTransportRef`, `sentByAgent` figés dès que l'ancien statut est `SENT` ou `DELETED`** (la preuve ne peut être ni altérée ni effacée, y compris en `DELETED`) ; `trashRequestedAt`, `trashedAt`, `purgedAt` ne peuvent passer que de `NULL` à non nul ; `DELETE` SQL refusé.

### 3.3 `worksite_photo_upload_reservations` (`WorksitePhotoUploadReservation`)
`id`, `companyId`, `idempotencyKey` (`Uuid`), `requestHash` (`Char(64)`), `worksiteId`, `truckId`, `uploadedById`, `photoId` (cuid **généré à la réservation**, non nul ; devient l'`id` de la photo au commit et figure dans `appProperties` Drive), `driveFileId` (**non nul, préalloué à la réservation** par `files.generateIds`, D15 ; unique), `state` (`RESERVED` | `UPLOADING` | `COMMITTED` | `ABANDONED` | `CLEANING` | `CLOSED`), `attemptGeneration Int` (défaut 1, incrémenté à chaque reprise), `attemptOwner` (`Uuid` de la tentative courante ou du cron), `leaseExpiresAt` (= `now + WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES`), `driveFileCreatedAt?` (renseigné dès qu'une tentative a la preuve que le fichier existe : 2xx **ou** 409 « id déjà utilisé »), `abandonedAt?`, `lastRemoteCheckAt?`, `remoteCheckCount Int` (défaut 0), `unresolvedAlertedAt?`, `closedAt?`, `closeReason?` (`FILE_DELETED` | `OPERATOR`), `closeNote?` (motif obligatoire pour `OPERATOR`), `createdAt`, `updatedAt`. `@@unique([companyId, idempotencyKey])`, `@@unique([id, companyId])`, `@@unique([photoId])`, `@@unique([driveFileId])`, `@@index([state, leaseExpiresAt])`, `@@index([state, lastRemoteCheckAt])`.

Machine d'états (R1, R2-1, R2-2) :

```
RESERVED → UPLOADING → COMMITTED   (succès ; terminal)
RESERVED | UPLOADING → ABANDONED   (bail expiré sans reprise, ou échec applicatif après upload ; NON réutilisable)
ABANDONED → CLEANING → CLOSED      (cron uniquement : suppression distante confirmée ; ou clôture par un opérateur, motivée et tracée)
```
- **Aucune clôture automatique sur absence** (R3-1) : aucun contrat ne borne l'instant où une ancienne tentative suspendue peut encore émettre ou achever un `files.create`, et un CAS SQL ne neutralise pas un effet distant. Une réservation `ABANDONED` dont le fichier est absent **reste `ABANDONED` indéfiniment** et reste dans la sélection du cron : contrôle `files.get` à chaque passage pendant `WORKSITE_PHOTOS_ABANDON_QUIET_HOURS`, puis **un contrôle par jour** sans limite de durée. Au terme de la période de calme, un événement `UNRESOLVED_ABANDON` et une notification aux administrateurs sont émis une fois (`unresolvedAlertedAt`). La seule clôture sans suppression est `CLOSED (OPERATOR)`, action d'un administrateur depuis le runbook, avec motif obligatoire et événement, par exemple après constat que l'identifiant préalloué n'existe pas côté Drive et que plus aucun processus ne peut l'utiliser ; ce n'est pas une déduction du cron.
- Toute écriture est un **CAS** `UPDATE … WHERE id = ? AND companyId = ? AND state = ? AND attemptGeneration = ?` ; une tentative dont le CAS échoue est **périmée** : elle n'écrit plus rien, ne supprime rien et répond 409 `UPLOAD_SUPERSEDED`.
- **Le chemin de requête ne supprime jamais rien sur Drive.** Le seul acteur qui appelle `files.delete` sur un fichier de réservation est le cron `reconcile`, depuis l'état exclusif `CLEANING` qu'il prend par CAS avec son propre bail. Il n'existe donc aucune compensation « en vol » issue d'une tentative périmée (R2-1).
- `ABANDONED`, `CLEANING` et `CLOSED` sont **non réutilisables** : un rejeu avec la même clé reçoit 409 `UPLOAD_ABORTED` et le client doit recommencer avec une **nouvelle** clé d'idempotence (nouvelle réservation, nouvel identifiant préalloué). Une publication est donc impossible sur une réservation en cours de nettoyage, et l'identifiant d'un fichier supprimé définitivement n'est jamais réutilisé (D18).
- Un appel Drive en vol ou différé d'une tentative périmée peut encore **créer** le fichier après coup (R2-2, R3-1) : c'est pourquoi `ABANDONED` reste **sous surveillance durable** du cron tant qu'une suppression n'a pas été confirmée (§6.3) ; l'absence observée n'est jamais une preuve de fin.
- Grâce à l'identifiant préalloué, deux tentatives d'une même réservation ciblent le **même** fichier : un second `files.create` échoue en 409 et est interprété comme « fichier déjà créé », puis vérifié par `files.get`.
- Invariants garantis : **au plus un fichier Drive et au plus une photo par clé d'idempotence** ; **aucune suppression d'un fichier référencé par une photo** (impossible par construction : une photo n'existe que sur une réservation `COMMITTED`, qui ne passe jamais en `CLEANING`) ; un fichier orphelin est **temporaire et détectable** (réservation non `COMMITTED` non `CLOSED`).

### 3.4 `worksite_photo_events` (`WorksitePhotoEvent`, ajout seul)
`id`, `companyId`, `photoId?`, `worksiteId?`, `action` (`RESERVED` | `UPLOAD_SUPERSEDED` | `UPLOADED` | `SENT` | `TRASH_REQUESTED` | `TRASHED` | `PURGED` | `CONTACT_SET` | `UNSENT_ALERT` | `ACCESS_GRANTED` | `ACCESS_DENIED` | `FILE_MISSING` | `CLEANUP_FAILED` | `UNRESOLVED_ABANDON` | `OPERATOR_CLOSE` | `RECONCILED`), `actorKind` (`USER` | `AGENT` | `SYSTEM`), `actorId`, `actorNameSnapshot`, `outcome` (`DONE` | `FAILED` | `GRANTED` | `DENIED`), `detail Json?` (jamais d'URL ni de secret : filtre repris de `v3-audit`), `createdAt`. Trigger : `UPDATE`/`DELETE` refusés.

### 3.5 `worksite_photo_drive_connections` (`WorksitePhotoDriveConnection`, patron `GmailConnection`)
`id`, `companyId` (unique), `accountEmail`, `accessToken` (chiffré), `refreshToken` (chiffré), `tokenExpiry`, `rootFolderId?`, `status` (`ACTIVE` | `ERROR` | `DISCONNECTED`), `lastErrorCode?`, `lastErrorAt?`, `connectedById`, `connectedAt`, `disconnectedAt?`, `updatedAt`. `DISCONNECTED` = tokens effacés localement (D16) ; `ERROR` = refresh refusé par Google (`invalid_grant`), quelle qu'en soit la cause (révocation globale, changement de mot de passe).

### 3.6 `worksite_photo_drive_folders` (`WorksitePhotoDriveFolder`)
Clé **par identité**, pas par nom : `(companyId, worksiteId, day)` pour les dossiers journaliers (`day` = jour civil `Date`), `(companyId, worksiteId, NULL)` pour le dossier du chantier, `(companyId, NULL, NULL)` pour la racine ; `driveFolderId` (**préalloué** par `files.generateIds`, comme pour les fichiers), `path` (libellé décoratif tel que créé, dont le suffixe `~<id6>`), `state` (`RESERVED` | `CREATED`), `createdAt`. Unicité `(companyId, worksiteId, day)` avec `NULLS NOT DISTINCT` (ou colonne sentinelle).

Protocole de création sérialisé : `INSERT … ON CONFLICT DO NOTHING RETURNING` de la ligne avec l'identifiant préalloué ⇒ la requête qui a inséré (ou qui trouve la ligne `RESERVED`) appelle `files.create` (`mimeType = application/vnd.google-apps.folder`, `id = driveFolderId`, `parents`) ; 2xx **ou** 409 « id déjà utilisé » ⇒ dossier existant ⇒ CAS `CREATED`. Deux uploads concurrents pour le même chantier et le même jour créent donc **un seul** dossier Drive, quelle que soit l'issue de la course. Cache : ligne `CREATED` réutilisée ; 404 Drive sur un dossier `CREATED` (suppression manuelle) ⇒ ligne remplacée par une nouvelle réservation avec un nouvel identifiant. Deux chantiers homonymes ont deux lignes et deux dossiers distincts. **Renommage** d'un chantier ou d'un client : l'identité ne change pas, les photos suivantes vont dans le **même** dossier ; le libellé Drive reste celui de la création (aucun renommage ni déplacement rétroactif).

### 3.7 Existant
- `Worksite` : + `clientContact String?` (brief : `contact_client`, renseigné par Hermes).

## 4. Droits (serveur, relus sous transaction ; la navigation n'autorise rien)

| Action | ADMIN / SUPER_ADMIN (entreprise explicite en session) | TEAM_LEADER | EMPLOYEE | CLIENT | Hermes |
|--------|------|------|------|------|------|
| Envoyer une photo | oui | oui, chantiers de son équipe | oui, chantiers affectés | non | non |
| Lister / voir ses photos et celles d'un chantier accessible | oui (toutes) | oui | oui | non | non |
| Lire le fichier (proxy) | oui | oui | oui | non | oui (`PENDING`, `SENT`) |
| Lister `PENDING` par chantier | via UI | non | non | non | oui |
| Renseigner `clientContact` | non (V1) | non | non | non | oui |
| Marquer `SENT` | non | non | non | non | oui, avec preuve |
| Supprimer (si `SENT`) | non (V1) | non | non | non | oui |
| Connecter / déconnecter Drive | oui | non | non | non | non |

Règles : session via `auth()` puis appartenance effective (`resolveCompanyAccess`, compte, fiche et entreprise actifs) ; `SUPER_ADMIN` sans `companyId` ⇒ 403 ; chantiers visibles : `EMPLOYEE` ⇒ `assignments.some.employeeAssignments.some.employeeId` (comme la liste et le détail `/chantiers`) ; `TEAM_LEADER` ⇒ `assignments.some.teamId` de l'équipe qu'il dirige (comme le **détail** `/chantiers/[id]` ; la liste `/chantiers` montre aujourd'hui tous les chantiers au chef d'équipe, écart existant **non repris** ici) ; `ADMIN`/`SUPER_ADMIN` ⇒ `{ companyId }` ; chantier `ARCHIVED` ou engin `active = false` ⇒ 409 ; cross-tenant ⇒ 404 uniforme, audité `DENIED`. Mutations : `assertMutationOrigin` (Origin / Sec-Fetch-Site, `PLANIFICATOR_TRUSTED_ORIGINS` pour la coque Capacitor). Réponses privées : `Cache-Control: private, no-store`, `Vary: Cookie`, `X-Content-Type-Options: nosniff` ; proxy : CSP `default-src 'none'; sandbox`, `Referrer-Policy: no-referrer`.

## 5. Authentification Hermes

- En-tête `Authorization: Bearer <jeton>` ; jeton lu depuis `WORKSITE_PHOTOS_AGENT_TOKEN` (≥ 32 octets, politique d'encodage fermée reprise de `src/lib/agent-gateway/secrets.ts`), comparé par `timingSafeEqual` sur SHA-256 ; absent, vide, `"undefined"`, mal encodé ou différent ⇒ 401 sans distinction.
- Entreprise liée `WORKSITE_PHOTOS_AGENT_COMPANY_ID`, vérifiée active à chaque appel ; kill-switch `WORKSITE_PHOTOS_AGENT_ENABLED=true` sinon 404.
- Interface `AgentPrincipalResolver` (entrée : requête ; sortie : `{ kind: "AGENT", label, companyId }` ou refus) pour migration ultérieure vers l'Agent Gateway sans toucher aux handlers.
- Rotation : `WORKSITE_PHOTOS_AGENT_TOKEN_PREVIOUS` accepté pendant une fenêtre de rotation (optionnel).
- Toute action Hermes ⇒ événement `actorKind = AGENT`.

## 6. Contrats HTTP

Toutes les routes : drapeau, erreurs stables `{ code, error }` sans détail interne, listes bornées. Les schémas Zod des corps et des réponses sont la source du contrat (Lot 4 les publie dans `docs/specs/worksite-photos/CONTRAT-AGENT-V1.md`).

### 6.1 Ouvriers (session) — `/api/worksite-photos`
| Méthode et route | Rôle |
|------------------|------|
| `GET /api/worksite-photos/context` | Chantiers photographiables (§4) et engins actifs de l'entreprise ; bornés |
| `POST /api/worksite-photos/worksites/:worksiteId/trucks/:truckId` | **Identifiants dans le chemin** (R3, patron V3 `handleDocumentUpload(request, truckId)`) : la pré-autorisation s'exécute sur les paramètres de route **avant** toute lecture du corps. Multipart `file` + `payload` JSON `{ phase, takenAt?, clientSha256?, worksiteId?, truckId? }` (≤ 32 Kio) ; si `payload` répète les identifiants, ils doivent être égaux au chemin sinon 400 `PAYLOAD_MISMATCH` ; en-tête `Idempotency-Key` UUID obligatoire ; 201 `{ photoId, status, drivePath }`, en-tête `Idempotency-Replayed` |
| `GET /api/worksite-photos?worksiteId=&cursor=&limit≤100` | Photos visibles avec statut, sans identifiant Drive ni URL |
| `GET /api/worksite-photos/:id/file` | Proxy privé du fichier (affichage), audit `ACCESS_GRANTED` avant flux |

### 6.2 Hermes (jeton) — `/api/worksite-photos/agent/v1`
| Méthode et route | Rôle | Idempotence / refus |
|------------------|------|---------------------|
| `GET …/photos?status=PENDING&worksiteId=&cursor=&limit≤100` | Groupé par chantier : `worksite { id, name, clientName, address, clientContact }`, `photos [{ id, truckMatricule, phase, uploadedAt, sizeBytes, sha256, drivePath }]` | Curseur opaque, ordre `uploadedAt, id` |
| `GET …/photos/:id/file` | Octets de la photo | 404 si `DELETED` |
| `PATCH …/worksites/:id/client-contact` | `{ clientContact }` e-mail | Rejouable ; événement `CONTACT_SET` |
| `POST …/photos/:id/mark-sent` | Corps **strict** `{ sentTo, sentMessageId, transportKind, transportRef?, sentAt? }` ; `transportKind` ∈ `smtp` \| `provider:<nom>` (motif `^(smtp|provider:[a-z0-9-]{1,32})$`), `transportRef` ≤ 255 ; `PENDING→SENT` sous `FOR UPDATE` | Champ obligatoire absent ou invalide ⇒ 400 `SENT_PROOF_REQUIRED` ; déjà `SENT` ou `DELETED` avec **preuve canonique identique** (`lower(btrim(sentTo))`, `btrim(sentMessageId)`, `transportKind` ; `sentAt` et `transportRef` ignorés au rejeu) ⇒ 200 rejoué sans aucune écriture ; preuve canonique différente ⇒ 409 `SENT_PROOF_CONFLICT`, preuve enregistrée inchangée |
| `DELETE …/photos/:id` | Refus 409 `PHOTO_NOT_SENT` si statut ≠ `SENT` ; sinon deux phases (§7.3) | Déjà `DELETED` ⇒ 200 rejoué ; `trashRequestedAt` posé ⇒ reprise à la phase Drive |

### 6.3 Administration et exploitation
| Route | Rôle |
|-------|------|
| `GET /api/auth/drive`, `GET /api/auth/drive/callback` | OAuth administrateurs (state HMAC, patron Gmail), scope `drive.file`, `access_type=offline`, création du dossier racine `Chantiers`, enregistrement chiffré |
| `GET /api/cron/worksite-photos-alerts` (Bearer `CRON_SECRET`, quotidien) | `PENDING` depuis ≥ `WORKSITE_PHOTOS_UNSENT_ALERT_DAYS` et `unsentAlertedAt IS NULL` ⇒ notification `WORKSITE_PHOTO_UNSENT` aux administrateurs actifs + événement ; **aucune suppression** |
| `GET /api/cron/worksite-photos-purge` (Bearer, quotidien) | `DELETED` avec `trashedAt` ≥ `WORKSITE_PHOTOS_PURGE_AFTER_DAYS` et `purgedAt IS NULL` ⇒ `files.delete` (404 = déjà purgé) ⇒ `purgedAt` |
| `GET /api/cron/worksite-photos-reconcile` (Bearer, horaire) | (a) Réservations `RESERVED`/`UPLOADING` dont le bail est expiré ⇒ CAS vers `ABANDONED` (`abandonedAt = now`, `attemptGeneration + 1`) : aucune suppression à ce stade. (b) Réservations `ABANDONED` dues pour contrôle (`lastRemoteCheckAt` nul ; ou toute heure pendant `WORKSITE_PHOTOS_ABANDON_QUIET_HOURS` après `abandonedAt` ; puis une fois par jour, **sans limite de durée**) ⇒ CAS vers `CLEANING` avec bail du cron ⇒ `files.get(driveFileId)` : **présent** ⇒ `files.delete` (définitif : fichier jamais rattaché, id jamais réutilisé) puis CAS `CLOSED` (`FILE_DELETED`) ; **absent** ⇒ retour à `ABANDONED` avec `lastRemoteCheckAt = now`, `remoteCheckCount + 1` ; si la période de calme est écoulée et `unresolvedAlertedAt` nul ⇒ événement `UNRESOLVED_ABANDON` + notification administrateurs, une seule fois. **Aucune clôture sur absence par le cron** (R3-1). `files.delete` au résultat inconnu ou bail du cron expiré ⇒ la réservation **reste** `CLEANING`, reprise au passage suivant par CAS (jamais réutilisable). Sélection bornée par passage, priorité aux `CLEANING` puis aux `ABANDONED` les plus anciens non contrôlés. (c) Suppressions de photos en cours (`trashRequestedAt` > 10 min, `trashedAt` nul) ⇒ `files.get(trashed)` puis TX2 (§7.3). (d) `CLEANUP_FAILED` (échec de `files.delete` depuis `CLEANING`) ⇒ nouvelle tentative bornée au passage suivant puis notification administrateurs. Chaque action ⇒ événement `RECONCILED` |

### 6.4 Codes d'erreur (ES-001-§13.4)
`UNAUTHENTICATED` 401, `FORBIDDEN` 403, `INVALID_ORIGIN` 403, `WORKSITE_NOT_FOUND` / `TRUCK_NOT_FOUND` / `PHOTO_NOT_FOUND` 404, `FEATURE_DISABLED` 404, `WORKSITE_ARCHIVED` / `TRUCK_ARCHIVED` 409, `PHOTO_NOT_SENT` 409, `PHOTO_DELETED` 409, `IDEMPOTENCY_CONFLICT` 409, `UPLOAD_IN_PROGRESS` 409 (+ `Retry-After`), `UPLOAD_SUPERSEDED` 409, `UPLOAD_ABORTED` 409 (nouvelle clé requise), `SENT_PROOF_REQUIRED` 400, `SENT_PROOF_CONFLICT` 409, `INVALID_PAYLOAD` / `INVALID_JSON` 400, `PAYLOAD_MISMATCH` 400, `PHOTO_CHECKSUM_MISMATCH` 400, `PHOTO_FILE_TOO_LARGE` 413, `PHOTO_TYPE_NOT_ALLOWED` / `PHOTO_TYPE_MISMATCH` 415, `DRIVE_NOT_CONNECTED` 503, `DRIVE_QUOTA_EXCEEDED` 503, `DRIVE_UNAVAILABLE` 502, `PHOTO_FILE_MISSING` 404, `SERVER_ERROR` 500.

## 7. Règles

### 7.1 Upload (publication)
1. Client : `<input type="file" accept="image/jpeg,image/png" capture="environment">` ; décodage avec orientation (`createImageBitmap`, `imageOrientation: "from-image"`) ; bord long 2048 px, JPEG qualité ≈ 0,82 ; si > 4 Mio : qualité 0,7 puis 1600 px ; sinon refus local. SHA-256 (`crypto.subtle`) ; `Idempotency-Key = crypto.randomUUID()` **conservé avec le blob** jusqu'au 201 ; tout nouvel appui réutilise la même clé.
2. Serveur : drapeau → `auth()` → origine → **pré-autorisation avant lecture du corps**, à partir des **paramètres de route** `worksiteId` et `truckId` (rôle, chantier accessible et non archivé, engin actif, même entreprise) ; en cas de refus, le flux n'est **pas consommé** (`request.body.cancel()`).
3. Lecture bornée du flux (`WORKSITE_PHOTOS_MAX_BYTES` + 64 Kio de marge multipart ; `Content-Length` jamais pris pour preuve) ; validation : magic bytes JPEG/PNG, extension et type déclaré cohérents, taille, SHA-256 (si `clientSha256` est fourni et diffère ⇒ 400 `PHOTO_CHECKSUM_MISMATCH`, **aucune réservation créée**) ; `requestHash` = SHA-256 canonique de `(companyId, actorId, worksiteId, truckId, phase, sha256, sizeBytes)`.
4. **Réservation** (`INSERT … ON CONFLICT DO NOTHING RETURNING` ; `photoId` = cuid, `driveFileId` = identifiant **préalloué** par `files.generateIds` (pris dans un petit stock par entreprise, renouvelé hors transaction), `attemptGeneration = 1`, `attemptOwner` = UUID de la tentative, `leaseExpiresAt = now + WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES`) : insérée ⇒ continuer ; `COMMITTED` même `requestHash` ⇒ 201 rejoué ; `requestHash` différent ⇒ 409 `IDEMPOTENCY_CONFLICT` ; `RESERVED`/`UPLOADING` avec bail non expiré ⇒ 409 `UPLOAD_IN_PROGRESS` (+ `Retry-After`) ; bail expiré ⇒ reprise par **CAS** (`attemptGeneration + 1`, nouvel `attemptOwner`, nouveau bail ; un seul gagnant), l'ancien exécutant devient périmé ; `ABANDONED` / `CLEANING` / `CLOSED` ⇒ 409 `UPLOAD_ABORTED`, le client recommence avec une **nouvelle** clé (D18).
5. Drive : CAS vers `state = UPLOADING` ; token valide (refresh si expiration < 5 min) ; dossiers résolus par identité et mis en cache (§3.6, libellé `/Chantiers/<client>-<chantier>~<id6>/<yyyy-MM-dd>`, jour civil `CompanySettings.timezone`) ; `files.create` `uploadType=multipart` avec **`id = reservation.driveFileId`**, `parents`, nom `<yyyyMMdd-HHmmss>_<matricule>_<AVANT|APRES>_<id8>.jpg`, `appProperties { reservationId, attemptGeneration, photoId, companyId, worksiteId, truckId, phase }`. Réponse 2xx **ou** 409 « a file already exists with the provided ID » ⇒ fichier existant, vérifié par `files.get(driveFileId)` (taille et `md5Checksum` cohérents avec le fichier validé, sinon 502 `DRIVE_UNAVAILABLE` et bail laissé au cron) ; CAS `driveFileCreatedAt = now`. Résultat réseau inconnu (timeout) ⇒ la tentative s'arrête sans rien supprimer ; le prochain essai rejoue l'étape 5 sur le même identifiant.
6. Transaction : `FOR SHARE` chantier et engin, relecture des droits, **CAS de la réservation** (`state = UPLOADING AND attemptGeneration = ?`) vers `COMMITTED`, insertion photo `PENDING` avec `id = reservation.photoId`, `driveFileId = reservation.driveFileId`, `reservationId`, événement `UPLOADED`. CAS échoué ⇒ rollback, 409 `UPLOAD_SUPERSEDED`, événement `UPLOAD_SUPERSEDED`, **aucune suppression Drive**. Aucun appel réseau dans la transaction.
7. Échec applicatif après upload (droits révoqués au commit, chantier archivé) : la tentative détentrice (CAS `attemptGeneration` vérifié) passe la réservation `ABANDONED` (`abandonedAt = now`) et répond l'erreur métier au client ; **aucun `files.delete` dans le chemin de requête** : le fichier sera supprimé par le cron depuis l'état exclusif `CLEANING` (§6.3). Le client qui veut réessayer repart avec une nouvelle clé.
8. Nommage Drive : noms de client et de chantier normalisés (suppression de `/ \ : * ? " < > |` et caractères de contrôle, espaces compactés, 80 caractères max), suffixe `~<6 car. de l'id du chantier>` systématique ; `drivePath` est un snapshot, jamais déplacé rétroactivement.

### 7.2 Marquage envoyée
Verrou `FOR UPDATE` sur la photo. Preuve canonique = `(lower(btrim(sentTo)), btrim(sentMessageId), transportKind)`, tous non vides, `sentTo` e-mail valide ≤ 254, `sentMessageId` ≤ 255 et **identifiant accepté par le transport**, `transportKind` ∈ `smtp` | `provider:<nom>`, `transportRef` facultatif (D17 ; provenance précisée dans `CONTRAT-AGENT-V1.md`). Persistance : `sentTo`, `sentMessageId`, `sentTransportKind`, `sentTransportRef`, `sentAt`, `sentByAgent`, tous figés après `SENT` (§3.2). **Frontière de confiance** : la preuve est une **déclaration d'Hermes**. Planificator vérifie sa forme, l'enregistre et la fige ; il **ne vérifie pas** le transport et les contraintes SQL ne constituent pas une vérification fournisseur. Le contrat agent impose à Hermes de n'appeler `mark-sent` qu'après avoir **observé une réponse de succès du transport** et de transmettre `transportKind` (`smtp` | `provider:<nom>`) et la référence correspondante ; l'acceptation par le transport n'atteste pas la livraison au destinataire. `PENDING` ⇒ écriture de `sentAt` (fourni, sinon `clock_timestamp()`), `sentTo`, `sentMessageId`, `sentByAgent`, statut `SENT`, événement `SENT` avec empreinte du destinataire (jamais l'adresse en clair dans `detail`). `SENT` ou `DELETED` ⇒ comparaison de la preuve canonique seule (`sentAt` ignoré) : identique ⇒ 200 rejoué **sans écriture** ; différente ⇒ 409 `SENT_PROOF_CONFLICT`, preuve enregistrée intacte. Les champs de preuve (`sentAt`, `sentTo`, `sentMessageId`, `sentTransportKind`, `sentTransportRef`, `sentByAgent`) sont figés par trigger après `SENT` (§3.2).

### 7.3 Suppression (deux phases)
1. TX1 : `FOR UPDATE`, `SENT` requis (sinon 409 `PHOTO_NOT_SENT`), `trashRequestedAt = now` si nul, événement `TRASH_REQUESTED`.
2. Drive : `files.update { trashed: true }` (idempotent ; 404 ⇒ considéré en corbeille, événement `FILE_MISSING` avec `detail.code = "PHOTO_FILE_MISSING"`).
3. TX2 : `FOR UPDATE`, **relecture de l'état** : si la photo est déjà `DELETED` (une autre requête ou le cron a terminé), aucune écriture, aucun événement, réponse 200 avec le résultat existant ; sinon `trashedAt = now`, `status = DELETED`, événement `TRASHED`. Deux TX2 concurrentes ne réécrivent jamais `trashedAt` ni ne dupliquent l'événement.
Échec entre 1 et 3 ⇒ statut `SENT` avec `trashRequestedAt` posé : rejeu Hermes ou cron `reconcile` termine. Rien n'est jamais supprimé définitivement par cette route.

### 7.4 Alerte J+7 et purge
Alerte : sélection `status = PENDING AND uploadedAt <= now - N jours AND unsentAlertedAt IS NULL`, bornée par exécution ; **une notification par chantier et par administrateur actif** de l'entreprise, indiquant le nombre de photos concernées et un lien vers la page ; `unsentAlertedAt` posé sur **chaque** photo dans la même transaction que les notifications (rejeu sans doublon). Aucune suppression. Purge : §6.3 ; `WORKSITE_PHOTOS_PURGE_AFTER_DAYS` borné à [1, 30] : Google vide automatiquement la corbeille après 30 jours, l'application ne peut donc **pas** garantir une conservation en corbeille au-delà, et le drapeau OFF ne suspend pas cette politique externe ; le cron confirme (`files.get` 404 ⇒ purgé) et trace.

### 7.5 Connexion Drive
Admin uniquement ; `prompt=consent`, `access_type=offline` ; tokens chiffrés avec `src/lib/encryption.ts` ; `invalid_grant` au refresh ⇒ `status = ERROR`, notification administrateurs, uploads 503 `DRIVE_NOT_CONNECTED` ; `storageQuotaExceeded` ⇒ 503 `DRIVE_QUOTA_EXCEEDED` + notification ; dossier racine `Chantiers` créé par l'application au premier usage (scope `drive.file`).

**Client OAuth partagé et déconnexion (R2, D16).** Le client OAuth (`GOOGLE_CLIENT_ID`) est celui déjà utilisé par les connexions Gmail. Google révoque l'accès **au niveau du projet Google et du compte**, pas par scope ni par token : un appel au point de révocation avec le token Drive retire l'accès accordé à l'application et invalide aussi les tokens Gmail du même compte ; un second client OAuth dans le même projet n'isolerait pas davantage. En conséquence : la déconnexion Drive est **locale** (tokens effacés en base, `status = DISCONNECTED`, événement), **aucun appel** au point de révocation Google ; l'écran Paramètres indique que la révocation complète se fait dans les paramètres du compte Google et qu'elle couperait aussi Gmail ; une révocation globale constatée (`invalid_grant`) est traitée symétriquement par les deux modules (chacun passe sa connexion en `ERROR`, aucun ne touche l'autre). Un client OAuth dédié dans un **projet Google distinct** reste l'option documentée si l'isolation de révocation devient nécessaire ; elle n'est pas créée par ce lot. Test de non-régression exigé : déconnexion Drive ⇒ aucune écriture sur `gmail_connections` / `acquisition_gmail_connections`, aucun appel réseau de révocation.

### 7.6 Observabilité
Logs `[worksite-photos] <EVENT> { companyId, photoId, outcome, code }` sans URL ni jeton ; table d'événements = audit métier ; compteurs exposés dans la page (photos en attente, en retard, connexion Drive).

## 8. Variables d'environnement (documentées, non créées par ce lot)

| Variable | Rôle | Défaut |
|----------|------|--------|
| `PLANIFICATOR_WORKSITE_PHOTOS_ENABLED` | Drapeau module (`=== "true"`) | off ⇒ 404 |
| `WORKSITE_PHOTOS_MAX_BYTES` | Taille max fichier, **plafond dur 4 Mio** | 3 Mio |
| `WORKSITE_PHOTOS_AGENT_ENABLED` | Kill-switch API Hermes | off |
| `WORKSITE_PHOTOS_AGENT_TOKEN` | Jeton Hermes, ≥ 32 octets | aucun ⇒ 401 |
| `WORKSITE_PHOTOS_AGENT_TOKEN_PREVIOUS` | Ancien jeton pendant une rotation | aucun |
| `WORKSITE_PHOTOS_AGENT_COMPANY_ID` | Entreprise liée au jeton | aucun ⇒ 401 |
| `WORKSITE_PHOTOS_UNSENT_ALERT_DAYS` | Seuil d'alerte | 7 |
| `WORKSITE_PHOTOS_PURGE_AFTER_DAYS` | Délai corbeille → purge, borné [1, 30] | 30 |
| `WORKSITE_PHOTOS_RESERVATION_TTL_MINUTES` | Bail d'une tentative d'upload, borné [5, 60] | 15 |
| `WORKSITE_PHOTOS_ABANDON_QUIET_HOURS` | Durée des contrôles horaires d'une réservation abandonnée avant passage à un contrôle quotidien **sans fin** et alerte `UNRESOLVED_ABANDON` ; ne clôture jamais sur absence ; bornée [1, 72] | 24 |
| `DRIVE_OAUTH_REDIRECT_URI` | Callback OAuth Drive | aucun ⇒ 500 |
| Réutilisées | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `PLANIFICATOR_TRUSTED_ORIGINS` | |

Prérequis Google Cloud (hors dépôt, à confirmer par Nizar) : API Drive activée, URI de redirection ajoutée, écran de consentement **en production**.

## 9. Architecture et frontières

```
src/lib/worksite-photos/
  feature-flag.ts            drapeau
  photo.domain.ts            états, transitions, nommage, validation fichier, requestHash (pur)
  photo.service.ts           autorité métier : TX, verrous, réservation, idempotence, audit
  photo.api.ts               handlers HTTP testables (deps injectées), session
  agent-auth.ts              AgentPrincipalResolver (jeton)
  agent.api.ts               handlers HTTP testables, Hermes
  photo-storage.port.ts      PhotoStoragePort + adaptateur Google Drive
  drive/drive-api.client.ts  REST Drive en fetch (patron gmail-api.client)
  drive/drive-connection.client.ts   tokens chiffrés + refresh
  drive/drive-folders.ts     résolution et cache des dossiers
  alerts.ts, reconcile.ts, purge.ts
src/lib/http/request-origin.ts, src/lib/http/bounded-body.ts     déplacés depuis vehicules (ré-export conservé)
src/lib/files/magic-mime.ts                                        déplacé depuis vehicules/v3 (ré-export conservé)
src/app/api/worksite-photos/**, src/app/api/auth/drive/**, src/app/api/cron/worksite-photos-*/   wrappers fins
src/app/(dashboard)/photos-engins/page.tsx, src/components/worksite-photos/**                    UI sans logique métier
```
Le module lit `Worksite`, `Truck`, `Company`, `User`, `CompanySettings` ; il n'écrit que ses tables et `Worksite.clientContact`. PWA : règle `runtimeCaching` `NetworkOnly` sur `/api/worksite-photos`. Navigation : entrée « Photos engins » dans `nav-config.ts` pour `EMPLOYEE`, `TEAM_LEADER`, `ADMIN`, `SUPER_ADMIN` (section Opérations), masquée drapeau OFF.

## 10. Cas limites (comportement attendu)

| Cas | Comportement |
|-----|--------------|
| Double appui / rejeu réseau | Même clé ⇒ même reçu ; un seul fichier Drive (identifiant préalloué + réservation avant upload) |
| Deux requêtes simultanées, même clé | Une réservation ; l'autre 409 `UPLOAD_IN_PROGRESS` puis rejeu |
| Fonction interrompue entre upload et TX | Reprise par le client (même clé, même `driveFileId`) ou par `reconcile` ; orphelin supprimé ou réservation réparée, jamais de doublon |
| Tentative A expirée, B reprend, A revient tard | Le CAS de A échoue ⇒ 409 `UPLOAD_SUPERSEDED`, A n'écrit ni ne supprime rien ; B et A ont ciblé le même `driveFileId` (409 Drive = déjà créé) |
| A échoue au commit après upload, B tente aussitôt la même clé (R2-1) | La réservation est `ABANDONED` : B reçoit 409 `UPLOAD_ABORTED` et repart avec une nouvelle clé ; personne ne peut publier sur cette réservation ; le cron seul supprimera le fichier depuis `CLEANING`. Aucune suppression « en vol » ne peut viser un fichier publié |
| Cron constate l'absence du fichier, puis l'upload tardif de A aboutit (R2-2) | La réservation reste `ABANDONED` sous surveillance : le passage suivant du cron voit le fichier, passe en `CLEANING`, le supprime, puis `CLOSED (FILE_DELETED)` |
| A suspendue **avant** son appel Drive pendant des jours, reprend après la période de calme (R3-1) | Sa publication est refusée (CAS) mais le fichier est créé ; la réservation est toujours `ABANDONED` (contrôle quotidien sans fin) : le fichier est détecté au contrôle suivant et supprimé. Aucune clôture automatique sur absence ne peut l'avoir retirée de la sélection |
| Réservation abandonnée sans fichier depuis longtemps | Reste `ABANDONED`, un contrôle par jour ; alerte `UNRESOLVED_ABANDON` émise une fois ; clôture uniquement par un administrateur (`CLOSED (OPERATOR)`, motif et événement) |
| `files.delete` du cron au résultat inconnu | La réservation reste `CLEANING` (non réutilisable) ; reprise par CAS au passage suivant jusqu'à `files.get` 404 ⇒ `CLOSED` |
| Upload Drive au résultat inconnu (timeout) côté tentative | Même identifiant au prochain essai : 409 Drive ⇒ existant, vérifié par `files.get` ; absent ⇒ création, toujours unique ; si le bail a expiré entre-temps, voir les deux lignes ci-dessus |
| Deux uploads simultanés, clés différentes, même chantier et même jour | Un seul dossier Drive : ligne de dossier réservée par `ON CONFLICT`, identifiant de dossier préalloué, 409 Drive = existant (§3.6) |
| Déconnexion Drive par un administrateur | Tokens effacés localement, `DISCONNECTED` ; connexions Gmail intactes ; aucun appel de révocation Google |
| Chantier archivé ou engin archivé après pré-autorisation | 409 au commit ; réservation `ABANDONED`, fichier nettoyé par le cron |
| Photo > 4 Mio après compression | Refus client ; côté serveur flux coupé à la borne ⇒ 413 |
| Fichier non image renommé `.jpg` | 415 `PHOTO_TYPE_NOT_ALLOWED` |
| Drive non connecté / token révoqué | 503 `DRIVE_NOT_CONNECTED`, connexion `ERROR`, notification, bouton « Reconnecter » |
| Quota Drive atteint | 503 `DRIVE_QUOTA_EXCEEDED`, notification |
| Dossier Drive supprimé à la main | Cache invalidé sur 404, recréation |
| Fichier Drive supprimé à la main | Proxy 404 `PHOTO_FILE_MISSING` audité ; `mark-sent` et `DELETE` restent cohérents |
| Suppression : corbeille OK, TX2 échoue | `SENT` + `trashRequestedAt` ; rejeu ou `reconcile` ⇒ TX2 |
| Suppression : TX1 OK, Drive injoignable | 502 ; rejeu sûr ; `reconcile` termine |
| `mark-sent` sans preuve / preuve différente | 400 / 409, aucune transition |
| Hermes supprime une photo `PENDING` | 409 `PHOTO_NOT_SENT`, événement `DENIED` |
| Photo `PENDING` à J+7 | Alerte unique aux administrateurs, badge ; jamais de purge |
| Renommage du chantier ou du client après upload | `drivePath` snapshot sur chaque photo ; le dossier Drive est résolu par identité (§3.6) : les photos suivantes vont dans le **même** dossier, dont le libellé n'est ni renommé ni déplacé |
| Cross-tenant | 404 uniforme, audité `DENIED` |
| `SUPER_ADMIN` sans `companyId` | 403 |
| Coupure réseau pendant l'upload | Blob et clé conservés côté client, « Réessayer » ; pas de file hors ligne en V1 |

## 11. Tests exigés (ES-001-§18, risque Critique)

- **Unitaires** (`node:test` + `tsx`) : transitions d'état ; normalisation des noms et chemins Drive ; jour civil et fuseau ; validation fichier (JPEG/PNG, refus PDF/HTML/renommé, vide, > max, plafond dur) ; `requestHash` ; schémas Zod ; auth agent (absent, vide, `"undefined"`, trop court, mal encodé, différent, entreprise inactive, kill-switch, temps constant) ; matrice de droits 5 rôles × actions ; sélections des crons (bornes J+7, purge, réconciliation) ; dimensions cibles de compression.
- **Handlers HTTP avec deps injectées** (patron `tests/vehicules/v3/document-routes.test.ts`) : codes 401/403/404/409/413/415/503 ; corps sans `driveFileId`, URL ni SQL ; en-têtes privés ; `Idempotency-Replayed` ; origine ; corps non lu quand la pré-autorisation échoue ; API agent (preuve, deux phases, pagination).
- **Client Drive et stockage** (fetch factice) : refresh unique puis retry ; `invalid_grant` ⇒ `ERROR` ; mapping `storageQuotaExceeded` ; multipart conforme (`parents`, `appProperties`) ; cache des dossiers, invalidation ; nettoyage depuis `CLEANING` et `CLEANUP_FAILED` ; aucun `files.delete` émis hors `CLEANING` (compteur du stockage factice).
- **PostgreSQL** (base jetable, patron `tests/vehicules/pg`) : migration, rejeu, `ROLLBACK.sql`, `migrate diff` = dérive préexistante seule, SQL borné par liste fermée (patron `migration-guard.ts`) ; FK composites cross-tenant refusées ; CHECK et triggers ; concurrence (deux uploads même clé ⇒ une réservation, un seul `driveFileId`, une ligne ; `mark-sent` et `DELETE` concurrents sérialisés ; reprise d'une réservation expirée par un seul gagnant) ; réconciliation ; isolation inter-entreprises (ES-001-§16.3).
- **Bail et reprise (R1)** : tentative A suspendue après l'appel stockage, bail expiré, reprise B, retour tardif de A ⇒ CAS de A refusé, A n'écrit ni ne supprime rien, une seule photo ; cron prenant le bail pendant le retour de A ⇒ même résultat ; `files.create` sur un identifiant déjà créé ⇒ 409 traité comme existant puis `files.get` ; le stockage factice refuse tout `files.delete` hors état `CLEANING` et toute suppression d'un `driveFileId` référencé par une photo (assertion du test, en plus de l'impossibilité par construction).
- **Nettoyage exclusif (R2-1)** : A échoue au commit ⇒ `ABANDONED` ; B rejoue la même clé ⇒ 409 `UPLOAD_ABORTED`, aucune photo ; aucun appel `files.delete` n'est émis par le chemin de requête (compteur du stockage factice à zéro) ; le cron passe `CLEANING` puis supprime ; `files.delete` au résultat inconnu ⇒ reste `CLEANING`, reprise au passage suivant, jamais réutilisable.
- **Upload tardif (R2-2, R3-1)** : création distante suspendue, bail expiré, cron ⇒ `ABANDONED` puis `files.get` absent ⇒ reste `ABANDONED` ; la création tardive aboutit ; passage suivant ⇒ fichier trouvé ⇒ `CLEANING` ⇒ supprimé ⇒ `CLOSED (FILE_DELETED)` sans rejeu utilisateur. Variante R3-1 : horloge avancée **au-delà** de la période de calme avec `files.get` absent à chaque passage ⇒ la réservation reste `ABANDONED`, `UNRESOLVED_ABANDON` émis une seule fois, cadence quotidienne ; puis l'ancienne tentative suspendue **avant** son appel Drive est relâchée et crée le fichier ⇒ le contrôle quotidien suivant le détecte et le supprime. Aucun chemin du cron ne produit `CLOSED` sans `files.delete` confirmé ; `CLOSED (OPERATOR)` exige un motif et produit un événement. Sélection du cron couvrant `ABANDONED` et `CLEANING`, pas seulement les baux expirés.
- **Dossiers (concurrence)** : deux clés différentes, même chantier et même jour, en parallèle ⇒ une seule ligne de dossier, un seul `files.create` effectif (le second reçoit 409 et le traite comme existant), deux photos sous le même parent ; dossier `CREATED` supprimé à la main (404) ⇒ nouvelle réservation avec nouvel identifiant.
- **Suppression (TX2)** : deux TX2 concurrentes ⇒ une seule écriture de `trashedAt`, un seul événement `TRASHED`, les deux réponses 200 identiques.
- **Pré-autorisation (R3)** : chantier interdit ou engin hors tenant ⇒ refus **sans consommation** du flux (lecteur factice jamais lu) ; divergence chemin / `payload` ⇒ 400 `PAYLOAD_MISMATCH` ; `payload` manquant, répété ou placé après le fichier ⇒ 400 ; flux au-delà de la borne ⇒ 413 avant fin de lecture.
- **Preuve d'envoi (R4, R5, R3-2)** : même `sentMessageId` et autre `sentTo` ⇒ 409 sans écriture ; même preuve canonique (casse et espaces différents, `transportRef` ou `sentAt` différents) ⇒ 200 sans écriture ; même `sentTo` et `sentMessageId` mais autre `transportKind` ⇒ 409 ; `transportKind` absent, vide ou hors motif ⇒ 400 `SENT_PROOF_REQUIRED`, aucune transition ; champ inconnu dans le corps ⇒ 400 (schéma strict) ; `UPDATE` SQL direct vers `SENT` sans `sentTo` ou sans `sentTransportKind` ou avec chaîne vide ⇒ refus CHECK ; `UPDATE` de `sentTo`/`sentMessageId`/`sentTransportKind`/`sentTransportRef`/`sentAt`/`sentByAgent` après `SENT` ou `DELETED` ⇒ refus trigger ; `INSERT` direct en `SENT`/`DELETED` ⇒ refus ; `SENT→DELETED` avec `sentTo = NULL` ⇒ refus.
- **Déconnexion Drive (R2)** : déconnexion ⇒ ligne Drive `DISCONNECTED`, aucune écriture sur les tables Gmail, aucun appel au point de révocation (fetch factice) ; `invalid_grant` au refresh ⇒ `ERROR` sans effet sur Gmail.
- **Rendu** (`renderToStaticMarkup`) : formulaire, états désactivés, messages par code, badge ; navigation par rôle et drapeau OFF.
- **Recette manuelle** (préproduction) : iPhone Safari PWA et coque Capacitor, Android Chrome ; compression, orientation, réseau lent, mode avion, double appui ; arborescence Drive et corbeille ; Hermes simulé en `curl` ; aucune fuite de jeton ou d'URL ; non-régression `test:vehicules*`, `test:chantiers`, `test:navigation`, `test:security:hotfix`.

## 12. Lots (chaque lot : branche `feat/worksite-photos-lot-N` depuis `origin/main`, PR, revue indépendante, relecture de Nizar ; aucun merge direct ; consigne budget Vercel du 29/10/2026 à respecter pour tout push)

| Lot | Contenu | Taille |
|-----|---------|--------|
| 0 | Cet ADR et cette SPEC ; module → SPECIFIED | S |
| 1 | Schéma, migration additive bornée + `ROLLBACK.sql`, CHECK/triggers, drapeau, `photo.domain.ts`, helpers partagés déplacés avec ré-export, tests unitaires + PG migration | M |
| 2 | Connexion Drive : table, routes OAuth, client Drive, refresh, dossiers, carte Paramètres, tests fetch factice | M |
| 3 | Upload ouvrier : route, service (réservation, bail, idempotence), page `/photos-engins`, compression client, navigation, règle PWA, tests handlers + rendu | L |
| 4 | API Hermes v1 : `agent-auth`, 5 routes, `CONTRAT-AGENT-V1.md`, tests handlers + PG isolation | M |
| 5 | Exploitation : crons alertes / purge / reconcile, `vercel.json`, notifications, runbooks `RB-PLAN-NNN` (drapeau OFF, reconnexion Drive, rotation jeton, réconciliation, rollback), tests sélection | S |
| 6 | Recette préproduction, PRR (ES-001-§25), activation, suivi, MODULE CLOSED (ES-001-§26) | S |

## 13. Critères d'acceptation du module (synthèse)

- Aucun octet ne part vers Drive sans réservation persistante portant un identifiant Drive préalloué et un bail ; une clé d'idempotence ne produit jamais deux fichiers Drive ni deux photos ; une tentative périmée n'écrit ni ne supprime rien ; le chemin de requête n'appelle jamais `files.delete` ; seul le cron de réconciliation supprime les orphelins de réservation, depuis l'état exclusif `CLEANING` d'une réservation non réutilisable (la purge des photos `DELETED` est une opération distincte, §6.3) ; un fichier référencé par une photo n'est jamais supprimé par la réconciliation ; un orphelin est temporaire et reste sous surveillance sans limite de durée jusqu'à suppression confirmée, jamais clos sur simple absence.
- Aucune réponse, aucun log, aucun événement ne contient de jeton, d'URL signée ni d'identifiant Drive exploitable par un ouvrier.
- `SENT` impossible sans preuve d'envoi complète et non vide ; preuve figée après `SENT` ; `DELETED` impossible sans `SENT` et sa preuve ; insertion directe hors `PENDING` impossible ; le tout vérifié par SQL direct.
- Déconnexion Drive sans effet sur les connexions Gmail et sans appel de révocation Google.
- Un ouvrier ne voit et ne photographie que les chantiers que `/chantiers` lui montre déjà.
- Drapeau OFF : production inchangée, suites existantes vertes.
- Tests PostgreSQL de concurrence et d'isolation verts ; `tsc` sans nouvelle erreur sur les fichiers du module ; revue indépendante obtenue.

## 14. Révision 2 — réponses à la revue indépendante Codex du Lot 0 (2026-10-30)

Verdict Codex sur la révision 1 : NO-GO (R1–R5). Chaque point a été vérifié contre le dépôt ou une source primaire avant intégration.

| # | Constat Codex | Vérification | Correction (révision 2) |
|---|---------------|--------------|-------------------------|
| R1 | La reprise d'une réservation expirée ne neutralise pas l'ancien exécutant ; « jamais deux fichiers Drive » non démontré | **Exact** : la révision 1 n'avait ni propriétaire ni génération de tentative, et laissait l'ancien exécutant commiter ou compenser | Bail : `attemptGeneration`, `attemptOwner`, `leaseExpiresAt` ; toute écriture et le commit sont des CAS sur `(state, attemptGeneration)` ; tentative périmée ⇒ 409 `UPLOAD_SUPERSEDED`, aucune compensation ; **identifiant Drive préalloué** par `files.generateIds` à la réservation (D15) : toutes les tentatives ciblent le même fichier, un second `files.create` ⇒ 409 traité comme existant ; résultat inconnu ⇒ rejeu sur le même identifiant ; aucune suppression d'un fichier référencé par une photo (§3.3, §6.3, §7.1, §10, §11) |
| R2 | La révocation Google à la déconnexion Drive invaliderait aussi Gmail (client OAuth partagé) | **Exact** : la révocation Google agit par client et par compte, pas par scope | Déconnexion **locale** (D16), aucun appel au point de révocation ; révocation globale traitée symétriquement par les deux modules ; projet OAuth distinct documenté comme option, non créé ; test de non-régression Gmail (§3.5, §7.5, §11) |
| R3 | Les identifiants ne sont que dans le corps : la pré-autorisation « avant lecture » est impossible | **Exact** : le patron V3 n'y parvient que parce que `truckId` est un paramètre de route | Route `POST /api/worksite-photos/worksites/:worksiteId/trucks/:truckId` ; pré-autorisation sur les paramètres de route, flux annulé en cas de refus ; `payload` peut répéter les identifiants, divergence ⇒ 400 `PAYLOAD_MISMATCH` (§6.1, §7.1, §11) |
| R4 | Le rejeu de `mark-sent` ne compare que `sentMessageId` | **Exact** | Preuve canonique `(lower(btrim(sentTo)), btrim(sentMessageId))`, `sentAt` ignoré au rejeu ; identique ⇒ 200 sans écriture ; différente ⇒ 409 sans modification (§6.2, §7.2, §11) |
| R5 | Les CHECK laissent `sentTo` nul en `DELETED`, acceptent les chaînes vides et n'empêchent pas d'altérer la preuve | **Exact** | Preuve complète non vide exigée pour `SENT` et `DELETED` (`length(btrim(x)) > 0`), `PENDING` sans aucun champ de preuve, trigger `BEFORE INSERT` imposant `PENDING`, trigger figeant les quatre champs de preuve après `SENT`/`DELETED`, horodatages monotones sans ordre imposé sur `sentAt` (§3.2, §11) |
| N1 | `PHOTO_FILE_MISSING` absent de l'énumération des actions | Exact | Action `FILE_MISSING` ajoutée, code dans `detail` (§3.4, §7.3) |
| N2 | Le suffixe `~id6` n'est pas une garantie anti-collision | Exact | Cache des dossiers clé par identité `(companyId, worksiteId, day)` ; le libellé est décoratif (§3.6) |
| N3 | Purge non bornée, rapport à la corbeille Google implicite | Exact | `WORKSITE_PHOTOS_PURGE_AFTER_DAYS` borné [1, 30], politique Google explicitée, drapeau OFF sans effet sur elle (§7.4, §8) |
| N4 | En-tête de l'index ADR obsolète ; numéro 004 déjà utilisé localement | Exact : `planificator-einvoicing` contient un `ADR-PLAN-004` non commité | En-tête corrigé ; cet ADR devient **ADR-PLAN-005** |
| N5 | Identifiant d'envoi Hermes : un hash local n'atteste pas l'acceptation par le transport | Exact | D17 : identifiant accepté par le transport (`Message-ID` ou identifiant du fournisseur), hash refusé (§2, §7.2) |
| N6 | TTL 15 min acceptable avec bornes et bail correct | — | Borné [5, 60] (§8) |

Nouvelles décisions soumises à Nizar : D15, D16, D17.

### Révision 3 — réponses à la revue Codex de la révision 2 (2026-10-30)

Verdict Codex sur la révision 2 : CHANGES_REQUIRED (R2-1, R2-2 bloquants ; quatre points majeurs ; trois mineurs). Avis favorable sur D15 (409 documenté par Google), D16 et D17 sous clarification.

| # | Constat Codex | Vérification | Correction (révision 3) |
|---|---------------|--------------|-------------------------|
| R2-1 | `ABORTED` réutilisable avant la fin de la compensation : un `files.delete` en vol d'une ancienne tentative peut supprimer un fichier qu'une nouvelle tentative vient de publier | **Exact** : la révision 2 autorisait la réinitialisation d'`ABORTED` et une compensation hors transaction par la tentative détentrice | Le chemin de requête **ne supprime plus jamais** sur Drive ; états `ABANDONED → CLEANING → CLOSED` réservés au cron, `CLEANING` exclusif sous bail CAS ; `ABANDONED`/`CLEANING`/`CLOSED` **non réutilisables** (409 `UPLOAD_ABORTED`, nouvelle clé et nouvel identifiant préalloué, D18) ; un identifiant supprimé n'est jamais réutilisé ; aucune publication possible pendant un nettoyage (§3.3, §6.3, §7.1, §10, §11) |
| R2-2 | Le cron peut constater l'absence puis clore, alors que l'upload tardif crée le fichier ensuite ; la réservation sort de la sélection | **Exact** : la révision 2 ne surveillait que les baux expirés et déduisait la clôture d'une observation ponctuelle | `ABANDONED` reste sous surveillance : contrôles `files.get` répétés, clôture sur absence seulement après `WORKSITE_PHOTOS_ABANDON_QUIET_HOURS` (24 h, borné [1, 72]) ; fichier trouvé plus tard ⇒ `CLEANING` ⇒ suppression ⇒ `CLOSED` ; sélection du cron étendue à `ABANDONED` et `CLEANING` (§3.3, §6.3, §8, §10, §11) |
| M1 | Création de dossiers Drive non sérialisée entre deux uploads concurrents | Exact | Ligne de dossier réservée par `ON CONFLICT` avec identifiant **préalloué**, `files.create` idempotent (409 = existant), états `RESERVED`/`CREATED` (§3.6, §10, §11) |
| M2 | D17 : la preuve est une attestation d'Hermes, pas une vérification du transport | Exact | Frontière de confiance écrite : déclaration d'Hermes, forme vérifiée et figée par Planificator, critère « réponse de succès du transport observée », `transportKind` et référence, acceptation ≠ livraison ; le CHECK SQL n'est pas une vérification fournisseur (§2 D17, §7.2) |
| M3 | TX2 de suppression : deux requêtes concurrentes pourraient réécrire `trashedAt` ou dupliquer l'événement | Exact | TX2 relit l'état sous verrou ; déjà `DELETED` ⇒ 200 sans écriture ni événement (§7.3, §11) |
| M4 | Renommage : contradiction entre cache par identité (§3.6) et « nouveau dossier » (§10) | Exact | Politique unique : même dossier, libellé figé à la création (§3.6, §10) |
| m1 | Titre « Décisions validées » englobait D15–D17 non arbitrées | Exact | §2 distingue D1–D14 validées et D15–D18 proposées |
| m2 | Révocation OAuth « par client et par compte » imprécis : Google révoque au niveau du projet et du compte | Exact | Formulation corrigée dans la SPEC et l'ADR ; un second client du même projet n'isole pas |
| m3 | « Formaliser le destin de l'identifiant après suppression définitive » | Exact | Jamais réutilisé : nouvelle clé ⇒ nouvel identifiant (D18) |

Décisions soumises à Nizar après cette révision : D15, D16, D17 (reformulée), **D18**.

### Révision 4 — réponses à la revue Codex de la révision 3 (2026-10-30)

Verdict Codex sur la révision 3 : CHANGES_REQUIRED (R3-1 bloquant, R3-2 majeur, deux mineurs) ; R2-1 clos ; avis favorable à D15–D18 sous ces corrections.

| # | Constat Codex | Vérification | Correction (révision 4) |
|---|---------------|--------------|-------------------------|
| R3-1 | Clore sur absence après une période fixe ne prouve pas l'absence d'effet distant futur : une tentative suspendue **avant** son appel Drive peut créer le fichier après la clôture, hors de la sélection du cron | **Exact** : aucun contrat ne borne l'instant d'émission d'un appel différé ; un CAS SQL ne neutralise pas un effet distant | **Aucune clôture automatique sur absence.** `ABANDONED` reste surveillé sans limite de durée : contrôle horaire pendant la période de calme, puis quotidien ; alerte `UNRESOLVED_ABANDON` émise une fois ; `CLOSED` uniquement après `files.delete` confirmé (`FILE_DELETED`) ou par un administrateur avec motif et événement (`OPERATOR`). Tests ajoutés : création relâchée **après** la période de calme, détectée au contrôle suivant (§3.3, §6.3, §8, §10, §11) |
| R3-2 | `transportKind` exigé par le texte mais absent du contrat HTTP et de la preuve persistée | **Exact** | Corps strict `{ sentTo, sentMessageId, transportKind, transportRef?, sentAt? }` ; colonnes `sentTransportKind` (obligatoire dans la preuve complète) et `sentTransportRef` ; `transportKind` dans la preuve canonique du rejeu ; figés après `SENT` ; tests champ absent/invalide, rejeu, altération (§3.2, §6.2, §7.2, §11) |
| m1 | Formulations « compensation » résiduelles | Exact | Remplacées par « nettoyage » ; événement `CLEANUP_FAILED` |
| m2 | « Seul le cron supprime » doit viser les orphelins, la purge des photos envoyées étant une autre opération légitime | Exact | Précisé : seul le cron de **réconciliation** supprime les **orphelins** de réservation ; la purge Drive des photos `DELETED` (§6.3) est une opération distincte sur des fichiers rattachés et passés par `SENT` |

Décisions D15, D16, D17, D18 (D18 précisée : clôture par opérateur seulement) : **validées par Nizar le 30/10/2026** sur cette révision.

### Clôture du Lot 0 (2026-10-30)

- Revue finale Codex de la révision 4 arbitrée : **GO documentaire**, aucun point bloquant ni majeur restant ; seule remarque éditoriale (« quatre champs de preuve ») corrigée en §7.2.
- **Acceptation formelle** de l'ADR-PLAN-005 et de cette SPEC par Nizar le 30/10/2026 (« Accepter ADR et SPEC ») : statuts **Accepté**, module **SPECIFIED**.
- Ce GO et cette acceptation portent sur les documents : ils ne valident aucune implémentation et n'autorisent ni push, ni PR, ni build, ni migration, ni activation. Le Lot 1 s'ouvre sur instruction de Nizar, dans le respect de la consigne budget Vercel du 29/10/2026.

### Révision 5 (proposée, en revue) — contrôle Super Admin (2026-10-31)

Décisions D19 à D21 et point ouvert D22 : voir [LOT-ADMIN-REVIEW](LOT-ADMIN-REVIEW.md). Statut `REJECTED` ajouté au cycle de vie (rejet avant envoi, terminal) ; validation interne indépendante du statut d'envoi ; suppression UI SUPER_ADMIN vers la corbeille Drive, sur les deux chemins (`PENDING → REJECTED`, `SENT → DELETED`). Aucune règle du Lot 1 n'est retirée.
