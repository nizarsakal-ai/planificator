# PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC |
| **Version** | **1.1.0 (R1)** |
| **Statut** | **SECURITY SPEC CLOSED** |
| **Programme** | PLAN-INTEGRATION-PLATFORM-001 — **LOT-0 SECURITY** |
| **Fichier canonique** | `docs/integration-platform-001-security.spec.md` |
| **Références** | Platform SPEC v1.1.0 (R1) ; IMPL-PLAN v1.1.0 (R1) ; SECURITY-SPEC-REVIEW-001 ; SECURITY-SPEC-R1-REVIEW-002 ; architecture Acquisition réelle ; GmailConnection legacy ; PLAN-GOVERNANCE-001 ; ENGINEERING-STANDARD-001 |
| **Date** | 2026-07-24 |
| **Code** | **Aucun** |
| **Migration** | **NO MIGRATION** |
| **Secrets réels** | **Aucun lu, affiché ni documenté** |

---

## 0. Objet et question normative

Ce document définit le **modèle de sécurité obligatoire** de la future Integration Platform **avant** toute implémentation de `IntegrationConnection`, `credentialsRef`, Connector Runtime, OAuth Platform, tokens, secrets, webhooks, uploads, rotation, révocation, accès payloads/artifacts et administration Platform.

**Question tranchée :**

> Comment Planificator stocke, protège, utilise, renouvelle, révoque et audite les secrets et accès de chaque `IntegrationConnection`, sans fuite cross-tenant et sans casser les connexions Gmail/Booking existantes ?

**Réponse normative (synthèse) :**

- Stockage V1 = **secrets chiffrés en base** (Option A) via **envelope encryption** : DEK par `CredentialVersion`, wrappée par une KEK/master key hors base.
- Référence opaque stable = **`credentialsRef`**.
- Discriminateur **`secretBackend`** : `LEGACY_GMAIL` | `PLATFORM_ENCRYPTED`.
- Pendant le strangler : store **`GmailConnection` = autorité** pour les tokens Gmail/Booking.
- Aucun code Platform avant **SECURITY SPEC CLOSED** (§32).
- Toute manipulation réelle de secrets/OAuth exige ensuite **SECURITY IMPLEMENTATION READY** pour le lot concerné.

---

## 1. Principes non négociables

1. Toute `IntegrationConnection` appartient à **une seule** Company (`companyId`).
2. **Aucun** secret global partagé entre tenants.
3. **Aucun** secret dans `config` (JSON publique uniquement).
4. **Aucun** secret dans les logs.
5. **Aucun** secret renvoyé à l’UI après écriture.
6. **Aucune** valeur secrète dans Server Actions, réponses JSON ou erreurs métier.
7. Séparation stricte **staging / production**.
8. Accès minimal par **rôle** et par **composant**.
9. **Rotation** et **révocation** obligatoires.
10. **Fail-closed** si la sécurité n’est pas correctement configurée.
11. **Aucun** déplacement des tokens Gmail/Booking sans SPEC Booking/Identity dédiée.
12. **Aucun** stockage de secret en clair.
13. Un seul champ `status` **ne porte jamais** à la fois Connection, Credential et Health.
14. La KEK Platform **ne déchiffre jamais** le store legacy Gmail.

---

## 2. Threat model

### 2.1 Actifs

Refresh tokens · access tokens · client secrets · API keys · app passwords · secrets IMAP futurs · signatures webhook · secrets upload · matériel de chiffrement (KEK/DEK) · payloads / corps / PJ · métadonnées Connection · audit.

### 2.2 Acteurs et surfaces

ADMIN tenant · SUPER_ADMIN · utilisateur non autorisé · opérateur système · Connector Runtime · Dispatcher (transport) · Server Actions · routes API · workers · DB · backups · logs · staging · production · Raspberry Pi scheduler · fournisseur compromis · token volé · attaque cross-tenant.

### 2.3 Menaces (catalogue)

Fuite de secret · substitution `connectionId` · cross-tenant · replay webhook · token expiré/révoqué · secret mal rotaté · logs sensibles · backup non protégé · vol KEK · confusion staging/prod · confusion **deux backends** (`LEGACY_GMAIL` / `PLATFORM_ENCRYPTED`) · SSRF · upload malveillant · élévation de privilège · désactivation non auditée · refresh storm · decrypt storm.

Mitigations : AEAD + AAD · AuthZ · redaction · `secretBackend` · verrous refresh · quarantaine upload · fail-closed env.

---

## 3. Modèle de stockage V1

### 3.1 Comparaison

| Option | Verdict |
|--------|---------|
| **A — Ciphertext en PostgreSQL** | **Retenue V1** |
| **B — Coffre externe** | Trajectoire future (contrat `credentialsRef` stable) |
| **C — Env par Connection** | **Rejetée** pour secrets dynamiques ; **conservée** pour secrets racine (KEK, `CRON_SECRET`, client secrets apps OAuth plateforme) |

### 3.2 Décision

```text
STRATÉGIE V1 = OPTION A + ENVELOPE ENCRYPTION (DEK par CredentialVersion)
Secrets Platform résolus uniquement via Secret Provider + credentialsRef.
```

Compatible Vercel + PostgreSQL + Raspberry Pi + multi-tenant dynamique.
Le legacy Gmail utilise déjà un stockage chiffré en colonnes — **isolé** sous `secretBackend = LEGACY_GMAIL` ; la Platform **n’hérite pas** de ce module.

---

## 4. Frontière Legacy Gmail / Platform

### 4.1 Discriminateur `secretBackend`

| Valeur | Autorité |
|--------|----------|
| `LEGACY_GMAIL` | Colonnes / tokens existants de `GmailConnection` |
| `PLATFORM_ENCRYPTED` | Secret store Platform (DEK/KEK, `credentialsRef`) |

Une `IntegrationConnection` (ou sa façade) **DOIT** indiquer explicitement quel backend fait autorité.

### 4.2 Normes strangler

- Tokens `GmailConnection` restent sous autorité **`LEGACY_GMAIL`**.
- La **KEK / master key Platform** ne doit **jamais** déchiffrer, ré-encrypter ou interpréter les colonnes legacy.
- Le Secret Provider Platform **refuse** toute résolution d’une référence marquée legacy.
- Le chemin legacy **refuse** toute résolution d’un secret `PLATFORM_ENCRYPTED`.
- **Aucune** copie permanente legacy → Platform.
- **Aucun** fallback silencieux d’un backend vers l’autre.
- Aucune UI ne présente une Connection legacy comme **migrée**.
- Reconnect / rotation / révocation utilisent **exclusivement** le backend déclaré.
- Migration legacy → Platform : SPEC dédiée + plan + rollback + preuve Booking.

### 4.3 Verdicts

```text
LEGACY_GMAIL_SECRET_STORE_REMAINS_AUTHORITY_DURING_STRANGLER
PLATFORM_MASTER_KEY_MUST_NEVER_DECRYPT_LEGACY_GMAIL_SECRETS
```

---

## 5. Hiérarchie de clés — envelope encryption

### 5.1 Décision V1 (normative)

```text
Chaque CredentialVersion possède une DEK aléatoire unique.
Le secret est chiffré en AEAD avec cette DEK.
La DEK est wrappée / chiffrée par une KEK (master key) hors base.
La base seule ne permet pas le déchiffrement.
```

Stockables en base : ciphertext du secret · DEK wrappée · nonce · tag · `keyId` · `encVersion` · métadonnées non secrètes.

### 5.2 Rejets V1

- Chiffrement **direct** de tous les secrets avec une seule clé maître **sans** DEK dédiée.
- Cryptographie artisanale.
- Nonce réutilisé.
- Chiffrement déterministe pour tokens.

### 5.3 AAD — figé à la création

L’AAD DOIT lier au minimum :

- `companyId`
- `connectionId`
- `secretKind`
- `environment`
- `secretVersion`

**Immutabilité :** ces champs sont **figés** pour une version chiffrée donnée.
Ils ne sont **jamais** « mis à jour » sur un ciphertext existant.
Tout changement d’un champ AAD ⇒ **nouvelle** `CredentialVersion` (déchiffrer avec ancien AAD → rechiffrer avec nouvel AAD → audit).

Mauvais AAD ⇒ déchiffrement **échoue** (fail-closed). Empêche le déplacement silencieux cross-tenant / cross-connection.

---

## 6. KEK / master key

### 6.1 Modèle V1

- **Une KEK active** par environnement pour les **nouvelles écritures**.
- Staging ≠ production.
- Chaque KEK a un `keyId`.
- Plusieurs `keyId` peuvent être **lisibles** temporairement pendant rotation.
- Anciennes KEK : uniquement pour unwrap/rewrap pendant une **fenêtre bornée**.
- Aucune ancienne clé ne reste indéfiniment **sans justification**.
- Emplacement : env sécurisée serveur (Vercel / Pi) ; **jamais** navigateur, dépôt, images build, DB.
- Fail-closed si KEK absente → `SECURITY_CONFIGURATION_INVALID`.

### 6.2 Rotation KEK

1. Introduire nouvelle KEK.
2. La déclarer active pour nouvelles écritures.
3. **Rewrapper** progressivement les DEK existantes (sans re-chiffrer le secret lorsque possible).
4. Vérifier métriques / erreurs ; alerter si secret utilise un `keyId` retiré.
5. **Interdiction** de retirer une KEK tant qu’une DEK active en dépend.
6. Retirer l’ancienne KEK après preuve complète.
7. Audit + procédure de rollback.

**SLA / fenêtre de rewrap** = fixés dans le lot de sécurité opérationnelle **avant production GO**.

### 6.3 Compromission KEK

Disable nouvelles opérations sensibles · nouvelle clé · rewrap/re-encryption contrôlé · audit incident · évaluation compromission ciphertexts · rotation secrets externes si nécessaire.

### 6.4 Migration KMS/coffre **obligatoire** si

- Volume de secrets au-delà d’un seuil (à fixer Ops).
- Besoin de rotation automatisée.
- Exigences réglementaires.
- Environnement multi-opérateurs.
- Blast radius jugé trop important.
- Incapacité à auditer suffisamment l’accès à la clé env.
- Passage à plusieurs runtimes ou régions.

```text
MASTER_KEY_V1 = KEK env sécurisée (distincte staging/prod ; distincte du matériel LEGACY_GMAIL)
MASTER_KEY_FUTURE = KMS / secret manager
```

---

## 7. `credentialsRef`

Terme **unique** normatif. (**Pas** de `secretRef`.)

### 7.1 Décision

- Handle logique **stable**.
- Référence une **identité de credential**, **pas** une version spécifique.
- Les `CredentialVersion` successives vivent **derrière** ce handle.
- La rotation **ne change pas** le `credentialsRef`.
- Le Runtime résout la version **ACTIVE** à partir du handle.
- Le domaine métier (Router, Pipeline, Review, Conversion, Extraction, UI, simulateur) **ne lit ni n’interprète** le handle.
- **Jamais** utilisé seul sans `companyId` + `connectionId`.

### 7.2 Droits

| Action | Qui |
|--------|-----|
| Créer / lier | Service Connection + AuthZ |
| Lire metadata / état | Admin / services Connection (jamais plaintext) |
| Résoudre plaintext | §12 uniquement |
| Révoquer / détruire | Service révocation + AuthZ (+ step-up si §13) |

---

## 8. États `CredentialVersion`

États normatifs :

| État | Norme |
|------|--------|
| `PENDING` | Créée ; **non** utilisée par runtimes normaux |
| `ACTIVE` | Seule version utilisable pour résolution normale |
| `REVOKED` | Immédiatement inutilisable |
| `RETIRED` | Remplacée après bascule réussie ; non utilisée |
| `FAILED` | Validation échouée ; **jamais** promue sans nouvelle validation |
| `DESTROYED` | Plus déchiffrable (DEK/matériel retiré selon politique) |

Normes :

- **Au plus une** version `ACTIVE` par `credentialsRef`.
- Promotion `PENDING` → `ACTIVE` **uniquement après validation**.
- Ancienne `ACTIVE` → `RETIRED` après bascule réussie.
- **Interdit** : deux `ACTIVE` concurrentes hors procédure de rotation **transactionnelle** explicite.

---

## 9. Rotation atomique des secrets

### 9.1 Programmée

1. Créer version `PENDING` (nouvelle DEK).
2. Chiffrer (AEAD + AAD figé).
3. Valider auprès du fournisseur ou health check sûr.
4. Bascule **atomique**.
5. Nouvelle → `ACTIVE`.
6. Ancienne → `RETIRED`.
7. Purger caches.
8. Auditer.
9. Observer.
10. Détruire selon rétention.

**Si validation échoue :** `PENDING` → `FAILED` ; ancienne `ACTIVE` **inchangée** ; aucune coupure silencieuse.

### 9.2 Concurrente

- Une seule rotation active par `credentialsRef`.
- Verrou ou contrainte persistée.
- Seconde demande **refusée** ou **sérialisée**.

### 9.3 Urgence

1. Disable Connection immédiat.
2. Révoquer côté fournisseur si possible.
3. Remplacer secret (`PENDING` → validate → ACTIVE).
4. Ancienne → `REVOKED`.
5. Purge cache ; reprise contrôlée ; audit.

### 9.4 Interdits

Supprimer l’historique d’audit · casser Booking / `LEGACY_GMAIL` · exposer la nouvelle valeur · deux ACTIVE sans TX.

```text
SECRET_VERSIONING_V1 = versions derrière credentialsRef ; une ACTIVE ; bascule atomique
```

---

## 10. Catégories de secrets et access tokens

| `secretKind` | Persistance | Notes |
|--------------|-------------|-------|
| `OAUTH_REFRESH_TOKEN` | Chiffré (CredentialVersion) | Longue durée |
| `OAUTH_ACCESS_TOKEN` | Voir §10.1 | Courte |
| `OAUTH_CLIENT_SECRET` | Env racine | Ops |
| `API_KEY` / `APP_PASSWORD` / `WEBHOOK_SIGNING_SECRET` / `UPLOAD_SIGNING_SECRET` / `CONNECTOR_OTHER` | Chiffré | Selon capability |
| `ENCRYPTION_MATERIAL` | Hors DB ou wrappé | Crypto service only |

### 10.1 Access tokens — décision corrigée

```text
Préférence par défaut = non-persistance de l’access token.
Le comportement exact dépend du ConnectorType et du modèle OAuth réel.
```

- Si refresh fiable : mémoire / cache court (si cache activé — §23).
- Si le fournisseur impose une persistance pour éviter refresh storm ou perte de disponibilité : stockage **chiffré** comme version temporaire **documentée** pour ce ConnectorType.
- **Aucune** persistance en clair.
- **Aucune** stratégie de refresh non coordonnée entre instances.

Exiger :

- Verrou de refresh par `companyId + connectionId`.
- Prévention refresh storm.
- Réutilisation bornée du token encore valide.
- Si le provider **ne renvoie pas** de nouveau refresh token : **conserver atomiquement** l’ancien valide ; **aucun** écrasement par valeur vide.
- Mise à jour atomique si refresh rotaté.
- Backoff erreurs fournisseur.
- Cache purge à révocation / rotation / disable.

Le legacy `GmailConnection` peut continuer à persister un access token **dans** `LEGACY_GMAIL` — hors autorité Platform.

---

## 11. OAuth lifecycle (Platform)

1. Initiation (ADMIN / SUPER_ADMIN cadré §13).
2. `state` : entropie cryptographique forte ; TTL court ; usage unique ; liaison user/session/company/connection intent ; stockage serveur ou signature robuste ; invalidation après usage ; rejet replay.
3. Callback sur redirect URI allowlist.
4. Validation `state` ; `OAUTH_STATE_INVALID` si échec.
5. Échange code (+ **PKCE** si supporté).
6. Stockage via Secret Provider (`credentialsRef` / `PLATFORM_ENCRYPTED`).
7. Activation `ConnectionStatus = ACTIVE` si succès.
8. Refresh Runtime uniquement (§10.1).
9. Expiration / révocation / reconnexion.

Compléments :

- Scopes **minimaux** ; consentement incrémental **seulement si nécessaire**.
- Absence de refresh token ⇒ état clair (`CredentialStatus` / `PENDING_AUTH`) ; reconnexion.
- Refresh concurrent **sérialisé**.
- Changement de Company pendant le flow **interdit**.
- SUPER_ADMIN : **confirmation explicite** de la Company ciblée ; callback **fail-closed** si session/intent ne correspondent plus.
- Erreurs provider → codes Platform (§21) ; détails bruts à la bordure.

**LOT-0 n’implémente aucun OAuth.** OAuth Gmail existant inchangé (§4).

---

## 12. Autorisation de résolution des secrets

### Peut résoudre

- Connector Runtime de la Connection concernée.
- Service de rotation.
- Service de révocation.
- Health check **si** strictement nécessaire (préférer probe sans plaintext).

### Ne peut jamais résoudre

Router · Normalizer (non requis V1) · Domain Pipeline · Review · Conversion · Extraction · UI · navigateur · simulateur · logs · analytics · **Dispatcher** (sauf s’il délègue explicitement au Runtime — le Dispatcher lui-même ne décide pas).

### API conceptuelle

```text
resolveCredential({
  companyId, connectionId, secretKind,
  runtimeCallerId, environment
}) → plaintext éphémère | error générique
```

Vérifs : `companyId` · `connectionId` · `secretKind` · runtime autorisé · environnement · `ConnectionStatus` / `CredentialStatus` · `secretBackend = PLATFORM_ENCRYPTED`.

### Dispatcher

- Transport / coordination technique **uniquement**.
- **Aucune** logique métier.
- **Aucune** résolution de secret sauf délégation explicite au Connector Runtime.
- Ne décide ni du matching ni de la création du draft.
- Ne contourne jamais les contrôles tenant.

---

## 13. Matrice AuthZ

Triple contrôle : **page → action/route → service**.
`companyId` de session = autorité ; jamais `companyId` client fiable.

### ADMIN tenant

**Peut :** initier connexion · reconnecter **sa** Company · désactiver/réactiver Connection de sa Company · consulter santé et audit **tenant** · demander une rotation **standard** si le ConnectorType le permet.

**Ne peut pas :** agir sur une autre Company · lire un secret · modifier la KEK · opérations Platform globales.

### SUPER_ADMIN

Intervention sur une autre Company **uniquement** avec : cible explicite serveur · justification obligatoire · audit renforcé · confirmation / **step-up** · **aucune** valeur secrète affichée.

### Service technique / Runtime

Résout uniquement : Connection attribuée · `secretKind` requis · bon environnement · identité de service autorisée.

### Step-up obligatoire (mécanisme = lot IMPL ; obligation = normative)

Révocation · rotation d’urgence · archivage · **changement de `secretBackend`** · reconnexion d’une autre Company par SUPER_ADMIN · destruction définitive.

UI secrets : saisie possible ; jamais relus ; états `MISSING` / `PENDING` / `ACTIVE` / `EXPIRED` / `REVOKED` / `FAILED`.

---

## 14. Multi-tenant

- Secret lié à Connection tenant-scopée.
- Invariant / FK composite `(companyId, connectionId)`.
- Aucune résolution par `credentialsRef` seul.
- Cache keys toujours tenantées (+ connection + version si cache).
- Aucune Connection partagée inter-tenant.
- Aucun fallback connexion globale.
- Tests cross-tenant systématiques.
- Jobs multi-tenant : chaque résolution **revalide** `companyId` ; pas de cache global.

### Même compte distant — deux Companies (décision unique V1)

```text
Deux Companies peuvent autoriser le même compte distant
UNIQUEMENT via deux consentements / Connections indépendants.
```

- Chaque Company : propre `credentialsRef`, ciphertext, audit, lifecycle.
- **Aucun** partage de secret ou de Connection.
- **Aucune** déduplication cross-tenant.
- **Aucune** réutilisation automatique d’un consentement existant.
- Détection d’un identifiant distant commun = alerte **interne** sans exposer l’autre tenant.
- En cas de doute sur les droits → **fail-closed**.
- Risque de **double ingestion** : traité par règles Platform / idempotence — **jamais** par partage de secret.

---

## 15. Trois machines d’état distinctes

### 15.1 `ConnectionStatus`

`PENDING_AUTH` · `ACTIVE` · `DISABLED` · `ERROR` · `ARCHIVED`

### 15.2 `CredentialStatus` (agrégat côté Connection / credential)

`MISSING` · `PENDING` · `ACTIVE` · `EXPIRED` · `REVOKED` · `RETIRED` · `FAILED`

(Les états fins de version restent sur `CredentialVersion` — §8.)

### 15.3 `RuntimeHealth`

`UNKNOWN` · `HEALTHY` · `DEGRADED` · `UNHEALTHY`

### 15.4 Matrice de comportement

| ConnectionStatus | CredentialStatus | Comportement |
|------------------|------------------|--------------|
| `ACTIVE` | `ACTIVE` | Runs autorisés si health acceptable |
| `ACTIVE` | `EXPIRED` / `REVOKED` | Aucun nouveau run ; reconnexion requise |
| `DISABLED` | `ACTIVE` | Aucun nouveau run ; secret conservé |
| `ERROR` | `ACTIVE` | Retry selon politique technique ; pas de changement secret automatique |
| `ARCHIVED` | * | Aucun run ; aucune reconnexion ordinaire ; historique conservé |
| `PENDING_AUTH` | `MISSING` / `PENDING` | Bloqué jusqu’à auth réussie |

**Interdit :** un seul champ `status` God-state portant les trois notions.

### 15.5 Disable / revoke / archive / delete

| Mode | Effet |
|------|--------|
| Connection `DISABLED` | Aucun nouveau run ; secret conservé ; historique préservé ; purge cache |
| Secret / version `REVOKED` | Résolution impossible ; `CredentialStatus` adapté ; alerte ; reconnexion |
| `AUTH` expirée | Mapped via `CredentialStatus = EXPIRED` ; refresh ou reconnect |
| Connection `ARCHIVED` | Soft ; non hard-delete si refs historiques |
| Hard delete Connection | **Interdit** tant que envelopes / routing / admissions / audit référencent |

Runs **en cours** : ne doivent pas prolonger l’usage d’un secret `REVOKED` au-delà du fail-closed ; scheduler refuse les **nouveaux** runs immédiatement.

---

## 16. Staging / production — preuves vérifiables

Obligatoire : bases · KEK · apps OAuth · redirect URIs · secrets · URLs · Pi/scheduler isolés · `CRON_SECRET` distinct · aucune copie token prod→staging · aucun fallback env · AAD `environment`.

**Preuves obligatoires avant production :**

1. Déchiffrement **échoue** avec mauvaise valeur d’environnement AAD.
2. Secrets et keys distincts staging/prod.
3. OAuth app + redirect URI distincts.
4. Scheduler **fail-closed** si URL/env incohérents.
5. `CRON_SECRET` distinct.
6. Pi staging/prod isolés.
7. Aucune restauration prod→staging sans procédure.
8. Test cross-environment dans la matrice sécurité.

---

## 17. Logs, PII et redaction

### 17.1 Interdits

Access/refresh tokens · client secrets · API keys · mots de passe · cookies · `Authorization` · URL signée complète · body · PJ · subject complet · email complet si non nécessaire · ciphertext complet · stack provider brute · query strings OAuth sensibles · filenames path-like dangereux.

### 17.2 Autorisés

`companyId` · `connectionId` · `connectorType` · `secretBackend` · secret/credential status · `keyId` · outcome · `errorCode` générique · `durationMs` · timestamp · `actorUserId`.

### 17.3 Gate redaction (normatif)

La fonction/service central de redaction **et** la politique de logs doivent être **disponibles et testés** avant :

- **LOT-1C** ;
- première résolution réelle d’un secret Platform ;
- premier callback OAuth Platform ;
- premier run Connector utilisant un secret.

Exiger redaction : headers · query params · erreurs provider · stack · URL signée · tokens · ciphertext · payloads sensibles.

Toute route/worker sensible **DOIT** utiliser cette redaction.
**Aucun** log libre de l’objet d’erreur provider.
Erreurs de déchiffrement répétées → alerte incident ; **pas** de détail crypto précis au client.

---

## 18. Audit

### 18.1 Audit administratif append-only

Journaliser individuellement : création · rotation · révocation · archive · disable/enable · **changement `secretBackend`** · reconnect · échec sécurité critique.

Champs : `companyId` · `connectionId` · `actorUserId` / service actor · action · outcome · `reasonCode` · version · date · environnement.

**Interdiction** d’enregistrer la valeur secrète.
Conceptuellement **append-only**.

### 18.2 Télémétrie de résolution (agrégée)

Nombre de résolutions · échecs · tenant mismatch · key version · runtime · latence — **jamais** valeur secrète.
**Ne pas** journaliser chaque déchiffrement réussi comme événement détaillé synchrone à fort volume.

### 18.3 Audit détaillé exceptionnel

Chaque résolution uniquement : actions manuelles privilégiées · incident · mode diagnostic activé · durée courte · justification + audit.

Rétention audit = politique Ops **séparée** du secret.

---

## 19. Backups et restauration

- Backup DB = ciphertext ; KEK **hors** backup DB.
- Restauration testée **obligatoire avant production**.
- Métadonnées critiques permettant après restore de reconnaître : version `REVOKED` · Connection `ARCHIVED` · secret compromis · `keyId` retiré · date de révocation · `reasonCode`.
- Journal de révocation/audit **protégé**, append-only ; modèle physique ultérieur, propriétés **normatives**.

Une restauration DB **ne réactive jamais automatiquement** :

- version `REVOKED` / `RETIRED` ;
- Connection `ARCHIVED` ;
- credential compromis.

Post-restore : validation · comparaison journal révocation/audit · **fail-closed** si métadonnées incohérentes.

Ciphertext sans KEK ⇒ illisible → Connections en erreur / `PENDING_AUTH` ; reconnexion ; pas de plaintext magique.

---

## 20. Cache

```text
Cache de secret déchiffré = OPTIONNEL en V1 ; DÉSACTIVÉ par défaut jusqu’à preuve de besoin.
```

Si activé :

- Mémoire processus uniquement ; TTL court.
- Clé = `companyId` + `connectionId` + `secretKind` + `secretVersion` (+ env).
- Aucune persistance disque.
- Purge rotation / revoke / disable.
- Multi-instance : le cache **n’est pas** source de vérité.
- Refresh coordonné par contrainte/verrou persistant.
- **Ne pas** promettre une zeroization mémoire garantie en environnement managé.

---

## 21. Erreurs

| Code | Classe |
|------|--------|
| `SECRET_NOT_CONFIGURED` | Configuration |
| `SECRET_DECRYPTION_FAILED` | Sécurité critique ; retry limité |
| `SECRET_VERSION_UNSUPPORTED` | Configuration |
| `CONNECTION_AUTH_FAILED` | Selon provider |
| `CONNECTION_AUTH_EXPIRED` | Refresh / reconnect |
| `CONNECTION_AUTH_REVOKED` | Permanent jusqu’à reconnect |
| `CONNECTION_FORBIDDEN` | Sécurité |
| `CONNECTION_TENANT_MISMATCH` | Sécurité critique |
| `ROTATION_FAILED` / `REVOCATION_FAILED` | Ops / critique |
| `OAUTH_STATE_INVALID` / `OAUTH_SCOPE_INSUFFICIENT` | Sécurité / config |
| `SECURITY_CONFIGURATION_INVALID` | Fail-closed |
| `SECRET_BACKEND_MISMATCH` | Sécurité (legacy vs Platform) |

---

## 22. Webhooks futurs

Invariants : signature · timestamp · tolérance · nonce/idempotency · anti-replay · résolution Connection serveur · pas de `companyId` payload fiable · rate limit · taille · secret signature tenant/connection · rotation.

**Aucun webhook / aucune migration en LOT-1A.**

---

## 23. Upload `.eml` / antivirus — décision V1

### Quarantaine obligatoire avant admission métier

1. Réception en zone de quarantaine **tenant-scopée**.
2. Vérification taille / type / **magic bytes**.
3. Parsing défensif (sans exécution).
4. Scan antivirus **ou** scanner de sécurité compatible.
5. Extraction PJ sous limites.
6. Rejet ou quarantaine si suspect / inconnu.
7. Admission Platform **uniquement** après état `CLEAN`.

### Si aucun scanner disponible

- Upload `.eml` **désactivé en production**.
- Staging : tests contrôlés **sans** généralisation.
- **Aucune** admission métier production.

### Interdits

Ingestion directe avant scan · rendu HTML actif · macros/scripts · confiance filename / MIME déclaratif · « hors V1 sans compensation ».

AuthZ ADMIN/SUPER_ADMIN · rate limit · hash · audit · pas d’ingestion simulateur · aucun secret extrait du message réutilisé comme credential.

---

## 24. SSRF

- **Aucune** URL extraite de `NormalizedInbound`, payload, body ou artifact n’est fetchée automatiquement.
- Endpoints custom **interdits en V1** sauf ConnectorType explicitement audité.
- Blocage : localhost · réseaux privés · metadata cloud · schémas non autorisés.
- Redirections et DNS rebinding contrôlés.
- Timeout / taille / protocole bornés.

Tout ConnectorType IMAP custom / endpoint custom / webhook sortant ⇒ **extension SECURITY-SPEC dédiée** avant implémentation.

---

## 25. Rate limits et abuse

Limites : Company · Connection · admin · OAuth init/callback · résolution secret · refresh · upload · IP/user.
Backoff · circuit breaker futur · détection échecs auth répétés · verrou temporaire **sans** destruction de données.

Prévenir : refresh storm · decrypt storm · verrouillage global · coûts fournisseur · saturation DB.

Valeurs exactes = Ops ; **gate : fixées avant activation prod**.

---

## 26. Observabilité sécurité

Événements : `INTEGRATION_AUTH_CONNECTED` · `REFRESHED` · `EXPIRED` · `REVOKED` · `SECRET_ROTATED` · `SECRET_ROTATION_FAILED` · `CONNECTION_DISABLED` · `SECURITY_TENANT_MISMATCH` · `OAUTH_STATE_REJECTED` · `SECRET_BACKEND_MISMATCH`.

Alertes : decrypt failures répétés · 401 provider · token expiré · secret absent · tenant mismatch · rotation échouée · `keyId` retiré encore utilisé.

---

## 27. Incidents

| Catégorie | Différenciateur |
|-----------|-----------------|
| Secret / token exposé | Disable Connection ; revoke provider ; rotate ; reconnect |
| **KEK compromise** | Stop ops sensibles env ; nouvelle KEK ; rewrap ; audit ; évaluer ciphertexts ; rotate secrets externes |
| Cross-tenant suspecté | Freeze ; investigation ; rapport |
| Logs contaminés | Purge / redaction ; scan négatif |
| Mauvaise rotation | Rollback version ; probe |
| Callback OAuth détourné | Reject ; allowlist |
| Backup exposé | Rotate KEK ; inventaire |

Preuves de clôture : kill switch · isolation · journaux · notification · non-récurrence · validation.
Runbooks concrets = lots ultérieurs ; **catalogue figé**.

---

## 28. Rétention et destruction

- Délais exacts **fixés avant production GO** ; propriétaire et approbateur identifiés.
- Secret `REVOKED` : ne reste pas indéfiniment sans justification.
- Destruction crypto (retrait DEK/KEK) seulement après respect audit/obligations.
- Destruction physique ciphertext selon politique.
- **Aucun** effacement en cascade du domaine métier.
- Audit préservé séparément.
- Restauration ne réactive pas silencieusement un secret révoqué.

---

## 29. Tests obligatoires futurs

### Unitaires / crypto

Encrypt/decrypt · mauvais AAD (`companyId`, `connectionId`, env, `secretKind`, `secretVersion`) · ciphertext corrompu · DEK wrappée mauvais `keyId` · nonce unique · redaction · transitions CredentialVersion · rotation concurrente · deux ACTIVE refusées.

### PostgreSQL

Isolation tenant · FK composites · unique ACTIVE · concurrence rotation · disable/revoke · archive.

### Intégration / OAuth

Callback valide/invalide · state rejoué · Company changée pendant flow · refresh concurrent multi-instance · secret absent · key rotation · restore version révoquée · cache purge après revoke.

### Frontière legacy

Legacy secret **refusé** par Platform provider · Platform secret **refusé** par legacy path.

### Upload

Quarantined / suspect / clean · magic bytes · limites.

### Sécurité

Logs inspectés · headers/query/stack redactés · SSRF · rate limiting · même compte distant deux tenants **sans** partage credential · Booking / `gmail-scan` / OAuth existant non régressés · Review/Conversion sans accès secret.

Primitives éprouvées uniquement — **pas** de crypto maison.

---

## 30. Rate limits — rappel gate

Valeurs chiffrées avant prod ; voir §25.

---

## 31. Décisions tranchées (récap)

| # | Décision | Verdict |
|---|----------|---------|
| 1 | Stockage | Option A + envelope DEK |
| 2 | KEK | Env ; multi-`keyId` temporaire ; KMS si seuils |
| 3 | `credentialsRef` | Handle stable ; versions derrière |
| 4 | CredentialVersion | PENDING/ACTIVE/REVOKED/RETIRED/FAILED/DESTROYED |
| 5 | Access token | Préférence non-persist ; ConnectorType ; anti-storm |
| 6 | Même compte distant | Deux Connections indépendantes |
| 7 | États | ConnectionStatus × CredentialStatus × RuntimeHealth |
| 8 | `secretBackend` | LEGACY_GMAIL \| PLATFORM_ENCRYPTED |
| 9 | Antivirus | Quarantaine + scan ; sinon OFF prod |
| 10 | Cache | Optionnel ; OFF par défaut |
| 11 | Audit résolutions | Agrégé ; détail exceptionnel |
| 12 | Redaction | Gate avant LOT-1C / première résolution |
| 13 | Legacy | Autorité strangler ; KEK Platform jamais sur legacy |
| 14 | Gates | SECURITY SPEC CLOSED ≠ IMPLEMENTATION READY |

---

## 32. Gates

### Clôture formelle

| Élément | Valeur |
|---------|--------|
| Revue indépendante finale | `PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC-R1-REVIEW-002` |
| Verdict de revue | `READY FOR SECURITY SPEC CLOSE` |
| Merge documentaire fondation Platform | PR **#18** (`ae7f5e3` sur `main`) |
| Effet | **LOT-1A** (contrats, sans secrets) **autorisé** |
| Interdit persistant | Aucune manipulation réelle de secrets ou OAuth avant **`SECURITY IMPLEMENTATION READY`** |

Les décisions normatives (KEK/DEK, `credentialsRef`, AuthZ, legacy Gmail, OAuth, sécurité) **ne sont pas** réouvertes par cette clôture.

### SECURITY SPEC CLOSED (documentaire)

1. Décisions normatives validées (cette SPEC R1).
2. Revue indépendante réussie (`PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC-R1-REVIEW-002`).
3. Corrections terminées.
4. Validation utilisateur.
5. Document **mergé sur `main`** (PR #18).

→ **LOT-1A** (contrats, sans secrets) peut commencer.

### SECURITY IMPLEMENTATION READY (futur, par lot secrets/OAuth)

Lot IMPL sécurité détaillé · schéma physique · crypto library choisie · migrations · tests · runbooks · rollback · observabilité.

→ Toute **manipulation réelle** de secrets ou OAuth exige cet état pour le lot concerné.

```text
Aucun code Platform avant SECURITY SPEC CLOSED.
Aucune résolution / OAuth Platform avant SECURITY IMPLEMENTATION READY du lot concerné.
```

---

## 33. Non-objectifs (LOT-0)

Implémenter le chiffrement · modifier OAuth existant · migrer `GmailConnection` · créer un coffre · ajouter un fournisseur · créer un webhook · créer l’upload `.eml` · écrire des runbooks · créer des migrations · modifier Platform SPEC · modifier IMPL-PLAN.

---

## 34. Risques résiduels

| Risque | Sévérité | Mitigation |
|--------|----------|------------|
| Confusion deux backends | Élevé | `secretBackend` + refus croisés + tests |
| KEK env sur Pi | Moyen | Accès restreint ; trajectoire KMS ; audit accès |
| Refresh storm serverless | Élevé | Verrou persisté ; préférence cache OFF |
| Upload sans scanner | Élevé | Feature OFF prod |
| Contamination logs | Élevé | Gate redaction avant LOT-1C |
| SLA rewrap non encore chiffré | Moyen | Gate avant prod GO |

---

## 35. Conformité gouvernance

```text
Platform SPEC R1 → IMPL-PLAN R1 → SECURITY-SPEC v1.1.0 R1 (ce fichier)
  → SECURITY SPEC REVIEW → corrections → validation → merge main
  → SECURITY SPEC CLOSED → LOT-1A
  → (plus tard) SECURITY IMPLEMENTATION READY → lots secrets / OAuth / 1C+
```

Nomenclature unifiée : `credentialsRef` · `IntegrationConnection` · `CredentialVersion` · `ConnectionStatus` · `CredentialStatus` · `RuntimeHealth` · `secretBackend`.

---

## 36. Verdict

**SECURITY SPEC CLOSED**

*Fin PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC v1.1.0 (R1) — LOT-0 SECURITY — NO MIGRATION*
