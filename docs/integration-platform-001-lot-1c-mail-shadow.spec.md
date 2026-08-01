# PLAN-INTEGRATION-PLATFORM-001 — LOT-1C Mail Shadow Bridge

## 1. Statut et objectif

| Champ | Valeur |
|-------|--------|
| Statut | **DRAFT FOR ARCHITECTURAL REVIEW** |
| Plan parent | PLAN-INTEGRATION-PLATFORM-001 |
| Lot | LOT-1C — Mail Shadow Bridge |
| Alignement SPEC parent | M1 — Parité Runtime |
| Dépendances | LOT-1A, LOT-1B1, LOT-1B2 fusionnés sur `main` |
| Implémentation | **Interdite** tant que cette SPEC n’est pas revue et GO explicite |

### 1.1 Objectif

Projeter de façon **passive** (shadow) le résultat d’une sync mail legacy déjà obtenue vers :

```text
DTO neutre → InboundEnvelope → NormalizedInbound (MESSAGE)
         → lifecycle NORMALIZED | NORMALIZE_FAILED
```

Contraintes non négociables :

- **Un seul** poll distant (réutiliser le résultat legacy).
- Legacy reste **seule** autorité métier.
- Shadow = **projection passive uniquement** — aucune mutation métier.
- Booking inchangé.
- Échec ou absence du shadow **MUST NOT** impacter le flux legacy.

### 1.2 Sources normatives

| Source | Rôle |
|--------|------|
| `docs/integration-platform-001.spec.md` | Family Normalizer §11 ; Shadow §20 / §28 ; obs §25 ; M1 |
| `docs/integration-platform-001.impl-plan.md` | Découpage §4 ; LOT-1C §8 ; flags §15 ; tests §25.1 |
| `docs/integration-platform-001-security.spec.md` | Redaction §17 ; gates secrets |
| `docs/integration-platform-001-lot-1b2-envelope.spec.md` | Persistance Envelope / Normalized ; CAS ; idempotence |
| Contrats LOT-1A | Formes Zod — **autorité de forme** ; ce lot ne les modifie pas sauf GO explicite |
| Repositories LOT-1B1 / LOT-1B2 | Ports de persistance — **autorité d’accès données** |

Cette SPEC **MUST NOT** republier intégralement les schémas Zod LOT-1A ni le SQL LOT-1B2.

---

## 2. Périmètre inclus (MUST)

1. **Gate-0 Redaction** — module minimal Integration (§8).
2. **Flags** fail-closed : foundation, shadow, tenant allowlist (§7).
3. **Provisioning administratif minimal** d’`IntegrationConnection` (§6) — **sans UI**.
4. **DTO neutre** à la frontière Acquisition → Integration (§5).
5. **Câblage fin Acquisition** : après résultat de sync legacy, construire le DTO et appeler le port shadow (best-effort).
6. **Family Normalizer MESSAGE** (§9).
7. **Orchestration shadow** (§10) : `createIdempotent` Envelope → normalize → CAS lifecycle.
8. **Observabilité** minimale (§12).
9. **Adapters** sous `src/lib/integration/connectors/mail-bridge/**` (chemin figé).
10. **Adaptation ciblée** de la gate architecture (§19).
11. Tests unitaires, intégration, non-régression (§16–§18).

---

## 3. Exclusions (MUST NOT)

| Domaine | Exclusion |
|---------|-----------|
| Router / matching | `RoutingDecision`, Sources, Rules, Bindings |
| Comparaison métier shadow | Parité matching (LOT-2) |
| Admission | `PipelineAdmission`, Draft Platform, dispatch |
| Artifacts | Persistance / download `InboundArtifact` |
| Replay | Replay automatique ou boucles de retry métier |
| Booking | `gmail-scan`, `src/lib/booking/**` |
| Legacy métier | Mutation du workflow Acquisition (Draft, eligibility métier, Review, Conversion, workers) |
| Secrets Platform | Résolution / OAuth Platform (exige `SECURITY IMPLEMENTATION READY`) |
| UI | Aucune interface utilisateur |
| LOT-1A / 1B1 / 1B2 | Modification des contrats ou migrations existantes hors nécessité prouvée et GO |
| Familles DOCUMENT / EVENT | Hors V1 |

---

## 4. Architecture et sens des dépendances

### 4.1 Sens autorisé

```text
Acquisition (sync legacy)
  → construit MailShadowInputDto (neutre)
  → appelle Integration MailShadowBridgePort
       → redaction (Gate-0)
       → resolve IntegrationConnection (lecture)
       → createIdempotent InboundEnvelope
       → Family Normalizer MESSAGE
       → create NormalizedInbound
       → transitionLifecycle CAS
```

### 4.2 Sens interdit

Aucun fichier sous `src/lib/integration/**` **MUST NOT** importer :

- `src/lib/acquisition/**` / `@/lib/acquisition/**`
- `src/lib/booking/**` / Booking
- Gmail métier / SDK fournisseur
- `@/app/**`, `@/components/**`, `@/lib/actions/**`

### 4.3 Emplacements figés

| Composant | Chemin |
|-----------|--------|
| Bridge + DTO + orchestration | `src/lib/integration/connectors/mail-bridge/**` |
| Family Normalizer MESSAGE | `src/lib/integration/normalizers/message/**` (ou sous-chemin équivalent figé en revue lot) |
| Redaction Gate-0 | `src/lib/integration/observability/redaction/**` |
| Flags | `src/lib/integration/flags/**` |
| Hook Acquisition | modification **minimale** de `acquisition-gmail-sync.service.ts` (et helpers listing si strictement nécessaires) |
| Bootstrap Connection | script ops / module admin CLI sous `scripts/` ou `src/lib/integration/ops/**` — **pas** d’UI |

### 4.4 Couches

| Couche | Responsabilité |
|--------|----------------|
| Acquisition hook | Après sync réussie locale : map → DTO ; appelle port ; **ignore** erreurs shadow |
| Bridge orchestrator | Flags, redaction, connection lookup, envelope, normalize, CAS, métriques |
| Family Normalizer | DTO/envelope → `NormalizedMessage` + hash ; **aucune** I/O Prisma directe (délègue aux repos via orchestrateur) |
| Mappers / repos LOT-1B2 | Validation Zod, taille, artifactRefs, persistance, idempotence, CAS |
| Redaction | Sanitize strings / structured log fields avant journalisation |

---

## 5. DTO d’entrée du bridge

### 5.1 Contrat

Nom conceptuel : `MailShadowInputDto`.

Le DTO **MUST** être :

- validé Zod **strict** côté Integration ;
- **neutre** : aucun type Gmail SDK, aucun type Acquisition Prisma, aucun import Acquisition ;
- sérialisable JSON ;
- suffisant pour produire Envelope + NormalizedMessage V1.

### 5.2 Champs minimums (MUST)

| Champ | Type conceptuel | Règle |
|-------|-----------------|-------|
| `companyId` | opaque id | Tenant |
| `externalId` | string non vide | Id message distant opaque |
| `idempotencyKey` | string non vide | Clé runtime ; **MUST** être stable pour un même message/canal |
| `receivedAt` | ISO-8601 UTC `Z` | Instant réception |
| `occurredAt` | ISO-8601 UTC `Z` | Instant événement source (peut égaler `receivedAt` si inconnu) |
| `payloadRef` | opaque ref | Référence payload — **jamais** body inline |
| `contentType` | string non vide | ex. `message/rfc822` ou type logique figé |
| `connectorTypeHint` | string optionnel | Si fourni, **MUST** matcher le snapshot Connection ; sinon Connection fait autorité |
| Champs MESSAGE | sous-objet conforme `normalizedMessageSchema` LOT-1A | `externalMessageId`, `contentCapabilities`, optionnels sender/recipients/subject/`bodyRef` |

### 5.3 Interdits dans le DTO

- body / MIME brut / HTML brut ;
- tokens / cookies / `Authorization` ;
- URL signées ;
- objets Prisma / SDK ;
- `draftId` / décisions métier ;
- `companyId` non aligné avec la Connection résolue.

### 5.4 Mapping Acquisition → DTO

Le mapping **MUST** vivre **côté Acquisition** (ou adapter Acquisition dédié hors `src/lib/integration/**`).

Integration ne reçoit **que** le DTO déjà neutre.

---

## 6. Provisioning IntegrationConnection

### 6.1 Règles

1. **MUST NOT** créer automatiquement une `IntegrationConnection` pendant le traitement d’un message.
2. Une Connection **MUST** exister et être éligible **avant** activation shadow pour le tenant/canal.
3. Bootstrap = mécanisme **administratif / ops** minimal (script ou fonction CLI) :
   - crée une Connection pour `(companyId, connectorType)` avec `secretBackend = LEGACY_GMAIL` (ou valeur figée alignée LOT-1B1) ;
   - `credentialsRef` / secrets : **pas** de résolution Platform dans ce lot ;
   - idempotent au sens ops (ne duplique pas silencieusement sans intention — politique exacte figée en revue lot : soit refuse si déjà présente, soit retourne l’existante documentée).
4. **Aucune UI** dans LOT-1C.

### 6.2 Résolution runtime

Le bridge résout la Connection par `(companyId, connectionId)` **ou** par sélecteur figé `(companyId, connectorType)` **uniquement si** une seule Connection éligible existe pour ce sélecteur.

Si le DTO ne porte pas `connectionId` :

- le sélecteur `(companyId, connectorType)` **MUST** être déterministe et documenté ;
- **ambiguïté** (0 ou N>1) → traiter comme `connection_missing` / non éligible (pas de create).

Recommandation normative : le hook Acquisition **SHOULD** passer un `connectionId` déjà provisionné pour éviter l’ambiguïté.

### 6.3 Absence de Connection

Si aucune Connection éligible :

| Action | Règle |
|--------|-------|
| Flux legacy | **MUST** continuer sans échec |
| Draft Platform | **MUST NOT** |
| Retry métier shadow | **MUST NOT** |
| Persistance Envelope/Normalized | **MUST NOT** |
| Observabilité | métrique/log redacted `connection_missing` |

Éligibilité minimale Connection (MUST) :

- même `companyId` ;
- `status` permettant le runtime shadow (au minimum `ACTIVE` ; `DISABLED` / `ARCHIVED` / `PENDING_AUTH` → non éligible) ;
- `secretBackend` compatible legacy mail pour ce bridge.

---

## 7. Flags

Noms env exacts **figés à l’implémentation** ; concepts obligatoires :

| Flag conceptuel | Défaut | Invariant |
|-----------------|--------|-----------|
| **Platform foundation** | OFF | OFF ⇒ shadow **interdit** |
| **Shadow** | OFF | ON ⇒ projection passive uniquement ; **aucune** mutation métier |
| **Tenant allowlist** | vide | Shadow autorisé seulement si `companyId` ∈ allowlist ; clé = id opaque, **jamais** nom d’entreprise |

### 7.1 Fail-closed

Le bridge **MUST** être inactif sauf si **tous** les points suivants sont vrais :

1. foundation ON ;
2. shadow ON ;
3. `companyId` dans allowlist ;
4. Gate-0 redaction disponible (module chargé / smoke test passé au boot du chemin shadow) ;
5. Connection éligible présente.

Sinon : no-op shadow + (si pertinent) métrique discrète ; **legacy intact**.

### 7.2 Kill-switch

Couper foundation **ou** shadow **MUST** arrêter immédiatement toute nouvelle projection shadow sans toucher au legacy.

---

## 8. Gate-0 Redaction

### 8.1 Objectif

Satisfaire SECURITY-SPEC §17 pour le **chemin Integration mail-shadow uniquement**.

### 8.2 Périmètre

| Inclus | Exclus |
|--------|--------|
| Logs et erreurs du bridge / normalizer / flags Integration | Refactor Booking |
| Masquage tokens, secrets, payloads bruts, PII listée SECURITY §17.1 | Refactor Acquisition logging global |
| API pure testable (`redactString`, `redactLogFields`, etc.) | Gestionnaire global de secrets / KEK / OAuth |

### 8.3 Règles

1. Le bridge **MUST NOT** s’activer si le module redaction est absent ou échoue son auto-check.
2. **Aucun** payload brut, body, MIME, token, stack provider dans les logs.
3. Champs autorisés alignés SECURITY §17.2 : `companyId`, `connectionId`, `connectorType`, `errorCode` générique, `durationMs`, outcome, timestamps.
4. Subject / email complets : **MUST NOT** journaliser en clair dans LOT-1C.

### 8.4 Tests Gate-0

Tests unitaires obligatoires : présence de motifs token/secret/body → sortie redacted ; pas de fuite sur objets Error.

---

## 9. Family Normalizer MESSAGE

### 9.1 Responsabilité

```text
MailShadowInputDto (+ Envelope créée)  →  NormalizedInbound MESSAGE
```

Conformément SPEC parent §11 :

| DOIT | NE DOIT JAMAIS |
|------|----------------|
| Produire un `NormalizedMessage` valide LOT-1A | Router / matcher |
| Calculer `normalizedHash` déterministe versionné | Créer Draft |
| Signaler échec normalisable | Appeler Review / Conversion / workers |
| Respecter borne taille UTF-8 via mapper LOT-1B2 | Importer Acquisition / Booking |

### 9.2 Sorties

- Succès → données prêtes pour `NormalizedInboundRepository.create`.
- Échec validation / sérialisation / taille → `NORMALIZE_FAILED` (voir §10–§11).

---

## 10. Orchestration

Ordre **MUST** (chemin nominal, flags OK, Connection OK) :

```text
1. Valider DTO (Zod)
2. Résoudre Connection éligible
3. InboundEnvelopeRepository.createIdempotent(...)
4. Si Envelope déjà en NORMALIZED avec Normalized V1 présent → duplicate / no-op normalize
5. Sinon Family Normalizer
6. NormalizedInboundRepository.create(...)
7. transitionLifecycle : expected [RECEIVED] → NORMALIZED
```

### 10.1 Lifecycle exact autorisé dans LOT-1C

| Transition | Condition |
|------------|-----------|
| `RECEIVED` → `NORMALIZED` | Normalized créé avec succès |
| `RECEIVED` → `NORMALIZE_FAILED` | Normalisation ou create Normalized a échoué de façon non récupérable dans ce lot |

**MUST NOT** dans LOT-1C : transitions vers `ROUTED`, `NO_MATCH`, `AMBIGUOUS`, `DISPATCHED`, `DISCARDED`, `ARCHIVED`.

### 10.2 Envelope existe déjà, Normalized manque

Cas : `createIdempotent` retourne une Envelope existante en `RECEIVED` (ou compatible) **sans** `NormalizedInbound` pour `(envelopeId, companyId, MESSAGE, schemaVersion V1)`.

**MUST** :

1. Tenter normalisation + `create` Normalized ;
2. CAS `RECEIVED` → `NORMALIZED` si succès ;
3. Si normalise échoue → CAS `RECEIVED` → `NORMALIZE_FAILED`.

Cas : Envelope en `NORMALIZE_FAILED` et Normalized toujours absent.

**MUST** : **aucune** boucle de retry automatique dans LOT-1C. No-op + métrique `normalize_failed` (déjà connu). Renormalisation = lot ultérieur / replay explicite hors 1C.

Cas : Envelope déjà `NORMALIZED` et Normalized V1 présent.

**MUST** : traiter comme **duplicate** (idempotent) ; pas de second Normalized ; pas de CAS.

Cas : Envelope `NORMALIZED` mais Normalized V1 **absent** (anomalie).

**MUST** : log redacted `errorCode=inconsistent_normalized_state` ; **MUST NOT** retry boucle ; **MUST NOT** impacter legacy. Correction manuelle / lot ultérieur.

### 10.3 Normalisation échoue

1. **MUST NOT** créer de Draft.
2. **MUST NOT** faire échouer le sync legacy.
3. **MUST** tenter CAS `RECEIVED` → `NORMALIZE_FAILED` si Envelope en `RECEIVED`.
4. Si CAS échoue (concurrence) → métrique conflit ; pas de throw vers legacy.
5. **MUST NOT** retry dans le même run ni planifier un retry shadow.

### 10.4 `create` Normalized → `NORMALIZED_VERSION_CONFLICT`

Interpréter comme **duplicate** de version (autre worker a gagné) : relire ; si présent et Envelope déjà normalisée → duplicate OK ; sinon métrique et stop (pas de retry boucle).

---

## 11. Gestion des erreurs

Principe : **best-effort shadow**.

| Situation | Legacy | Shadow |
|-----------|--------|--------|
| Flags OFF / hors allowlist | inchangé | no-op |
| `connection_missing` | inchangé | métrique ; no-op |
| Erreur validation DTO | inchangé | log redacted ; no-op |
| Erreur persistance Envelope | inchangé | log ; no-op |
| Normalize fail | inchangé | `NORMALIZE_FAILED` si possible |
| Exception inattendue bridge | inchangé | catchall + log redacted ; **jamais** rethrow vers caller métier sync |
| Redaction indisponible | inchangé | shadow **désactivé** fail-closed |

**MUST NOT** : retry métier, file d’attente shadow, backoff agressif, circuit-breaker qui coupe le legacy.

**SHOULD** : exécuter le shadow **après** que le résultat legacy utile soit déjà déterminé ; **MUST NOT** bloquer ni ralentir significativement le chemin legacy (invocation async ou try/catch borné — choix d’impl figé en revue : synchrone court avec budget temps max **ou** `setImmediate`/queue in-process sans I/O Gmail supplémentaire).  
**MUST NOT** : second poll Gmail.

---

## 12. Observabilité

Events / métriques minimales (labels SECURITY-compatibles) :

| Nom | Signification |
|-----|----------------|
| `received` | Projection tentée / Envelope créée (première fois) |
| `duplicate` | Idempotence : Envelope/Normalized déjà présents |
| `normalized` | Transition vers `NORMALIZED` réussie |
| `normalize_failed` | Échec normalize / CAS vers `NORMALIZE_FAILED` |
| `connection_missing` | Pas de Connection éligible |
| `duration` | Durée shadow (ms) |

Champs log autorisés : §8.3.  
**MUST NOT** : payload brut, body, tokens.

---

## 13. Idempotence

Alignée matrices parent (niveaux 1–3) :

| Niveau | Comportement LOT-1C |
|--------|---------------------|
| Runtime / DTO | Même `(companyId, connectionId, idempotencyKey)` → même Envelope effective |
| Envelope | `createIdempotent` LOT-1B2 (compatible → existant ; incompatible → conflit logué, no-op métier) |
| Normalized | Unique `(envelopeId, companyId, family, schemaVersion)` ; conflit version = duplicate |

Shadow **MUST NOT** créer de second Draft ni second message métier.

---

## 14. Concurrence

1. Deux invocations shadow parallèles sur le même DTO : **MUST** converger (une Envelope ; au plus un Normalized V1) via contraintes SQL + idempotence repos.
2. CAS lifecycle : un gagnant ; perdant → `LIFECYCLE_CONFLICT` absorbé (métrique), pas d’impact legacy.
3. Tests de concurrence réelle **SHOULD** reprendre le pattern LOT-1B2 (`Promise.all`).

---

## 15. Sécurité et données sensibles

1. Gate-0 redaction obligatoire (§8).
2. DTO sans secrets (§5.3).
3. Pas de résolution secret Platform.
4. `secretBackend` legacy : lecture Connection uniquement ; pas de decrypt Platform.
5. Multi-tenant : toute requête repository filtrée `companyId`.
6. Pas de log cross-tenant identifiers au-delà de `companyId` / `connectionId`.

---

## 16. Tests unitaires (MUST)

- Redaction : motifs sensibles → absents en sortie.
- Flags fail-closed (matrice foundation × shadow × allowlist).
- Validation DTO Zod (strict, champs interdits).
- Family Normalizer : happy path ; message invalide ; taille excessive.
- Orchestrateur : `connection_missing` ; duplicate ; normalize_failed ; inconsistent state.
- Aucun import interdit (complément gate).

---

## 17. Tests d’intégration (MUST)

- Sur DB jetable (garde URL safe LOT-1B1/1B2) :
  - create Envelope + Normalized + lifecycle `NORMALIZED` ;
  - Envelope existante sans Normalized → complète ;
  - double appel → duplicate ;
  - Connection absente → aucune ligne Envelope ;
  - normalize fail → `NORMALIZE_FAILED` sans Normalized (ou sans version V1).
- Isolation tenant conservée (réutiliser patterns 1B2).

---

## 18. Tests de non-régression (MUST)

| Critère | Preuve |
|---------|--------|
| **Un seul poll Gmail** | Mock provider : exactement **1** listing/fetch distant par run sync ; shadow n’ajoute aucun appel |
| **Zéro Draft supplémentaire** | Compteur `WorksiteImportDraft` / messages métier = baseline legacy pour le même run |
| **Legacy inchangé** | Chemins eligibility / registerIncomingMessage / erreurs sync : comportement préservé (tests existants verts + scénario shadow ON/OFF) |
| Booking | Aucun fichier Booking modifié ; smoke import paths |

---

## 19. Gate architecture

### 19.1 Conservé

Interdit universel : Acquisition, Booking, Gmail métier, app, components, actions **depuis** `src/lib/integration/**` (hors adaptation ci-dessous).

### 19.2 Adaptation LOT-1C (sans exception globale)

1. **Autoriser** l’existence de fichiers sous `src/lib/integration/connectors/mail-bridge/**` et `normalizers/**`, `observability/redaction/**`, `flags/**`.
2. **Retirer ou restreindre** le motif aveugle `connectors/mail-bridge` s’il interdit le package lui-même ; le remplacer par des règles :
   - `mail-bridge` **MUST NOT** importer Acquisition/Booking ;
   - couches `types` / `contracts` / `registry` **MUST NOT** importer `connectors/**` ni `normalizers/**` ;
   - `persistence/**` **MUST NOT** importer `connectors/**`.
3. **MUST NOT** ouvrir une exception globale autorisant `@/lib/acquisition` dans Integration.

Le hook Acquisition **MAY** importer Integration (sens autorisé).

---

## 20. Critères de sortie (Parité Runtime)

Le lot **MUST NOT** être CLOSED tant que :

1. SPEC respectée (ce document) + revue architecturale + GO.
2. Gate-0 redaction livrée et testée.
3. Flags fail-closed prouvés.
4. Bridge shadow : Envelope + Normalized + lifecycle uniquement.
5. Tests unitaires, intégration, non-régression verts.
6. **Un seul poll** prouvé.
7. **Zéro Draft extra** prouvé (shadow ON).
8. Legacy sync / eligibility non régressés.
9. Booking intact (diff vide sur arborescence Booking).
10. Gate architecture adaptée et verte.
11. Observabilité §12 vérifiée.
12. Rollback flags testé (§21).
13. Aucun LOT-2 (routing) démarré dans le même diff.

---

## 21. Rollback / kill-switch

| Action | Effet |
|--------|-------|
| Shadow OFF | Stop projections ; legacy seul |
| Foundation OFF | Stop shadow (+ futurs features foundation) |
| Retirer tenant de l’allowlist | Stop pour ce tenant |
| Données shadow déjà écrites | **Conservées** (pas de DELETE massif dans 1C) ; hors autorité métier |

Rollback **MUST NOT** exiger une migration destructive.

---

## 22. Risques

| ID | Risque | Mitigation |
|----|--------|------------|
| R4 | Booking cassé | Allowlist fichiers ; interdiction `gmail-scan` |
| R5 | Shadow mutatif | Interdits §3 ; tests zéro Draft |
| — | Ralentissement legacy | Best-effort ; budget ; pas de 2ᵉ poll |
| — | Fuite logs | Gate-0 |
| — | Connection manquante silencieuse | Métrique `connection_missing` ; runbook ops bootstrap |
| — | Scope creep Router | Exclusions §3 / §23 |
| — | Gate mal assouplie | §19.2 règles ciblées |

---

## 23. Hors LOT / LOT-2

Reporté explicitement à **LOT-2+** :

- Sources / Rules / Bindings / Tenant Router ;
- persistance / comparaison `RoutingDecision` ;
- shadow matching parity ;
- simulateur ;
- `PipelineAdmission` / Draft Platform / dispatch ;
- `InboundArtifact` workers ;
- replay explicite et audit d’attempts ;
- UI admin Connection ;
- secrets Platform / OAuth Platform.

---

## 24. Points figés (récapitulatif normatif)

| Point | Décision |
|-------|----------|
| Envelope existe, Normalized manque, lifecycle `RECEIVED` | Compléter normalize + CAS → `NORMALIZED` ou `NORMALIZE_FAILED` |
| Envelope `NORMALIZE_FAILED` | Pas de retry auto LOT-1C |
| Normalize échoue | CAS → `NORMALIZE_FAILED` ; legacy intact |
| Retry | **Interdit** dans LOT-1C |
| Lifecycle | Uniquement `RECEIVED→NORMALIZED` et `RECEIVED→NORMALIZE_FAILED` |
| Flags | Fail-closed (foundation ∧ shadow ∧ allowlist ∧ redaction ∧ Connection) |
| Legacy | Jamais bloqué / échoué à cause du shadow |
| Logs | Aucun payload brut |

---

## Historique

| Version | Date | Statut |
|---------|------|--------|
| 0.1.0 | 2026-08-01 | DRAFT FOR ARCHITECTURAL REVIEW |
