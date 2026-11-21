# PLAN-INTEGRATION-PLATFORM-001 — LOT-8 : coffre à secrets (PLATFORM_ENCRYPTED) et vraies connexions

| Champ | Valeur |
|---|---|
| **Statut** | **PROPOSÉ — en attente de validation** |
| **Date** | 21/11/2026 |
| **Demande** | Brancher pour de vrai Google Agenda, puis Shopify, Mailchimp et Slack (aujourd'hui en simulation dans le centre de connecteurs, lot F) |
| **Décision préalable** | Coffre conforme à `docs/integration-platform-001-security.spec.md` (SECURITY SPEC CLOSED) **avant** toute connexion réelle, sans chiffrement simple à clé unique (choix validé le 21/11/2026) |
| **Normes applicables** | SECURITY-SPEC §5 à §21 et §24 à §26 ; IMPL-PLAN §2 (gates, allowlists) |

## 1. Pourquoi un lot dédié

Le centre de connecteurs (lot F) interdit aujourd'hui tout mode réel, à quatre niveaux :

- l'énumération `ConnectorMode` ne contient que `DISABLED` et `SIMULATION` ;
- des CHECK et des déclencheurs en base réservent la synchronisation au mode `SIMULATION` ;
- le transport livré est un double fictif, sans aucun appel réseau ;
- des tests statiques vérifient l'absence de module réseau et de secret.

Une vraie connexion demande des clés d'API ou des jetons OAuth. La SECURITY-SPEC impose leur stockage sous `secretBackend = PLATFORM_ENCRYPTED`, en chiffrement d'enveloppe. Ce stockage n'existe pas encore dans le dépôt : `IntegrationConnection.credentialsRef` est un handle sans résolveur.

Le chiffrement simple à clé unique du Gmail historique (`src/lib/encryption.ts`, `LEGACY_GMAIL`) est **rejeté** par la §5.2. La Platform n'en hérite pas (§4).

## 2. Découpage

| PR | Contenu | Prérequis côté exploitation |
|---|---|---|
| **8A — Coffre à secrets** | `CredentialVersion` + service de chiffrement d'enveloppe + résolution + rotation + révocation + audit. Aucun connecteur branché. | KEK de production et KEK de préproduction générées et posées dans Vercel |
| **8B — Shopify, Mailchimp, Slack (lecture seule)** | Mode `LIVE` du lot F adossé à une `IntegrationConnection` ; saisie des clés (jamais relues) ; transports réseau bornés ; synchronisation hors transaction puis écriture transactionnelle | Clés créées dans chaque service |
| **8C — Google Agenda (OAuth, lecture seule)** | Bouton « Se connecter avec Google » ; `state` à usage unique + PKCE ; portée `calendar.readonly` ; refresh token dans le coffre, access token en mémoire seulement ; verrou de refresh | Client OAuth Google dédié (production et préproduction distinctes), adresse de retour déclarée |

Chaque PR est un lot fermé, avec ses tests et sa revue. Une PR ne démarre qu'après la fusion de la précédente sur `main` (IMPL-PLAN §2.1).

## 3. PR 8A — Coffre à secrets

### 3.1 Modèle (migration additive)

Table `integration_credential_versions` :

- **Identité et tenant**
  - `id`
  - `companyId` + `connectionId`, avec une clé étrangère composite vers `integration_connections (companyId, id)`
  - `credentialsRef`, le handle stable de §7
- **Nature et cycle de vie**
  - `secretKind` : `API_KEY`, `OAUTH_REFRESH_TOKEN`, `CONNECTOR_OTHER`
  - `environment` (`production` ou `preview`)
  - `secretVersion` : entier croissant par `credentialsRef`
  - `status` : `PENDING`, `ACTIVE`, `REVOKED`, `RETIRED`, `FAILED`, `DESTROYED`
- **Matériel chiffré**
  - `keyId` et `encVersion`
  - `wrappedDek`, `dekNonce`, `dekTag`
  - `ciphertext`, `nonce`, `tag`
- **Métadonnées non secrètes**
  - `hint` : 4 derniers caractères au plus
  - `createdById`
  - horodatages : `activatedAt`, `retiredAt`, `revokedAt`, `revokedReason`

Contraintes portées par la base :

- index unique partiel : **au plus une version `ACTIVE` par `(companyId, credentialsRef)`** (§8) ;
- `secretVersion` unique par `(companyId, credentialsRef)` ;
- longueurs exactes : nonce 12 octets, tag 16 octets ;
- matériel chiffré **immuable** une fois écrit : seuls `status` et les horodatages de transition changent, sur un graphe d'états fermé (§8) ;
- aucune suppression, aucun `TRUNCATE`.

Table `integration_secret_audit_logs`, en ajout seul (§18.1) :

- champs : action, issue, `reasonCode`, version, environnement, acteur ;
- **jamais** de valeur secrète.

### 3.2 Chiffrement (§5, §6)

- **Chiffrement du secret**
  - DEK aléatoire de 32 octets **par version**.
  - Secret chiffré en AES-256-GCM avec un nonce aléatoire de 12 octets (`node:crypto`, aucune cryptographie maison).
  - AAD = JSON canonique de `{ companyId, connectionId, secretKind, environment, secretVersion }`, figé à la création (§5.3).
- **Chiffrement de la DEK**
  - DEK enveloppée par la KEK active (AES-256-GCM, AAD = `keyId` + identité de la version).
- **KEK**
  - Lue côté serveur : `INTEGRATION_KEK_ACTIVE_ID` + `INTEGRATION_KEK_<ID>` (base64, 32 octets).
  - Plusieurs `keyId` lisibles pendant une rotation (§6.1).
  - KEK absente, mal formée, identique à `GMAIL_TOKEN_ENCRYPTION_KEY`, ou environnement incohérent : **fail-closed** `SECURITY_CONFIGURATION_INVALID`.
- **Environnement**
  - Dérivé de `VERCEL_ENV`. Un ciphertext de préproduction ne se déchiffre pas en production (preuve §16.1).

### 3.3 Services

- `storeCredential` : crée une version `PENDING`.
- `activateCredential` : promotion atomique après validation. L'ancienne version `ACTIVE` passe `RETIRED` dans la même transaction, sous verrou `FOR UPDATE` du handle (§9.1, §9.2).
- `failCredential` : passe une version `PENDING` à `FAILED` ; la version `ACTIVE` reste inchangée.
- `revokeCredential` : `ACTIVE` passe `REVOKED`, avec motif ; la résolution devient impossible immédiatement (§9.3).
- `resolveCredential({ companyId, connectionId, secretKind, runtimeCallerId, environment })` : plaintext éphémère ou erreur générique de §21.
  - Vérifications : tenant, connexion, `secretBackend = PLATFORM_ENCRYPTED`, statuts, appelant autorisé (§12).
  - Aucun cache en V1 (§20).
- Toute erreur passe par `src/lib/integration/observability/redaction/redact.ts` (gate §17.3) : aucun log brut.

### 3.4 Tests de fermeture

- Aller-retour chiffrement / déchiffrement.
- Échec avec mauvais AAD : `companyId`, `connectionId`, `secretKind`, `environment` et `secretVersion` (§5.3, §16.1).
- KEK absente, courte ou égale à la clé Gmail : `SECURITY_CONFIGURATION_INVALID`.
- Rotation de KEK : relecture avec l'ancien `keyId`, écriture avec le nouveau.
- Sur PostgreSQL jetable :
  - une seule version `ACTIVE` ;
  - bascule atomique ;
  - deux rotations concurrentes sérialisées ;
  - `REVOKED` non résoluble ;
  - matériel chiffré immuable ;
  - cross-tenant refusé ;
  - aucun `DELETE` ni `TRUNCATE`.
- Contrôle statique : aucune valeur secrète dans les journaux ni dans l'audit ; aucun import du module Gmail.

## 4. PR 8B — Shopify, Mailchimp, Slack

- **Lien Connection**
  - Chaque connecteur réel du lot F est adossé à une `IntegrationConnection`, avec `secretBackend = PLATFORM_ENCRYPTED` et les trois machines d'état de §15.
  - Le lot F gagne le mode `LIVE`, ajouté à l'énumération par une migration séparée de son usage (contrainte PostgreSQL sur `ALTER TYPE … ADD VALUE`).
- **Saisie**
  - Formulaire ADMIN de la société de session ; jamais réaffiché ; seul `hint` est montré (§13).
  - Clés validées par une requête de santé en lecture avant la promotion `ACTIVE` (§9.1).
- **Transports**
  - Un seul fichier réseau, des hôtes **fixes** (§24) :
    - Shopify : `<boutique>.myshopify.com`, domaine validé ;
    - Mailchimp : `<dc>.api.mailchimp.com`, centre de données dérivé de la clé ;
    - Slack : `slack.com`.
  - Requêtes bornées : délai d'attente, taille, aucune redirection suivie.
- **Codes d'erreur stables**
  - 401 et 403 : `CONNECTION_AUTH_FAILED`.
  - 429 : `RATE_LIMITED`.
  - Autres cas : `SOURCE_UNAVAILABLE`.
- **Ressources (lecture seule)**
  - Shopify : commandes et clients (`since_id`).
  - Mailchimp : membres d'une audience (consentement).
  - Slack : canaux publics, sans aucun envoi.
- **Synchronisation**
  - Lecture réseau **hors transaction**, bornée à 20 pages de 50 éléments.
  - Puis, en une transaction : verrou du réglage, revérification du mode et du curseur, écriture en zone de transit, journal, avancement du curseur.
  - Idempotence et empreintes inchangées.
  - Les données réelles restent en zone de transit : aucune table métier n'est touchée (règle du lot F).
- **Données personnelles**
  - E-mails des clients et contacts en zone de transit : finalité, durée et accès à valider (RGPD) avant activation.

## 5. PR 8C — Google Agenda

Elle suit la §11 :

- initiation par un ADMIN ;
- `state` aléatoire, à usage unique, TTL court, lié à l'utilisateur, à la société et à l'intention ;
- PKCE (S256) ;
- adresse de retour en liste fermée ;
- portée minimale `https://www.googleapis.com/auth/calendar.readonly` ;
- refresh token dans le coffre (`OAUTH_REFRESH_TOKEN`) ; access token en mémoire seulement (§10.1) ;
- refresh sérialisé par `companyId + connectionId`, sans jamais écraser un refresh token par une valeur vide ;
- pas de refresh token reçu : `PENDING_AUTH` et demande de reconnexion.

L'OAuth Gmail existant reste **inchangé** (§4).

Client OAuth : distinct de Gmail et distinct entre production et préproduction (§16.3).

## 6. Hors périmètre

- Écriture vers les services : aucun envoi Slack, aucune création d'événement Google.
- Intégration des données reçues dans les devis, factures ou clients (lot I).
- Stripe, Meta Ads, Google Ads, Outlook et SharePoint.
- ChatGPT : aucune API d'historique n'existe.
- KMS ou gestionnaire de secrets externe (§6.4, futur).

## 7. Gates avant activation en production

1. 8A fusionnée ; KEK de production et de préproduction posées et **distinctes** ; preuve que le déchiffrement échoue avec un mauvais environnement.
2. Limites de débit (§25) fixées et procédure de rotation de KEK écrite (§6.2).
3. Restauration de base testée (§19).
4. RGPD validé pour les données personnelles en zone de transit (Shopify, Mailchimp).
