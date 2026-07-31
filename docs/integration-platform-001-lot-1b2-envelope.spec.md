# PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2 Envelope Persistence

## 1. Statut et périmètre

| Champ | Valeur |
|-------|--------|
| Statut | **DRAFT FOR IMPLEMENTATION** |
| Plan parent | PLAN-INTEGRATION-PLATFORM-001 |
| Lot | LOT-1B2 — Envelope Persistence |
| Dépendance | **LOT-1B1 IntegrationConnection Persistence** fusionné sur `main` |
| Contrats amont | LOT-1A (inchangés dans ce lot) |

### 1.1 Inclus (MUST)

- Persistance `InboundEnvelope`
- Persistance `NormalizedInbound`
- Stockage `NormalizedMessage` en JSONB (`message`)
- Idempotence Envelope sur `(companyId, connectionId, idempotencyKey)`
- Lifecycle atomique compare-and-set (`transitionLifecycle`)
- Versionnement NormalizedInbound insert-only
- Repositories, mappers, taxonomie d’erreurs stables
- Tests unitaires et PostgreSQL (y compris concurrence réelle)
- Migration Prisma/SQL **additive** uniquement

### 1.2 Exclus (MUST NOT)

- Table `InboundArtifact` / stockage binaire / téléchargement d’artifacts
- `RoutingDecision` / `PipelineAdmission`
- Draft / Booking / Acquisition / Gmail / bridges métier
- Replay / audit d’attempts
- Politique complète (graphe) des transitions de lifecycle
- Colonnes d’erreur de normalisation, compteurs de replay, historique de transitions
- Modification des contrats LOT-1A
- **LOT-1C** (ne MUST NOT démarrer avant merge de LOT-1B2)

---

## 2. Sources normatives

| Source | Rôle |
|--------|------|
| `docs/integration-platform-001.impl-plan.md` | Découpage lots, lifecycle Envelope §7.3, idempotence multi-niveaux, bornes taille |
| `docs/integration-platform-001.spec.md` | Normes Envelope / NormalizedInbound / retention (référence, non dupliquée ici) |
| Contrats LOT-1A sous `src/lib/integration/contracts/**` et `types/**` | Formes publiques Zod / enums — **autorité de forme** ; ce lot ne les modifie pas |
| LOT-1B1 — `IntegrationConnection` + `src/lib/integration/persistence/**` | Pattern repository/mapper/erreurs, `@@unique([id, companyId])`, gate Prisma |
| Conception LOT-1B2 corrigée (revue) | Décisions figées reprises ci-dessous |

Ce document **MUST NOT** republier intégralement les schémas Zod LOT-1A. Il fige uniquement la **persistance** et les règles d’accès associées.

---

## 3. Modèle InboundEnvelope

| Attribut | Valeur figée |
|----------|--------------|
| Nom Prisma | `InboundEnvelope` |
| Nom SQL | `integration_inbound_envelopes` |

### 3.0 Convention SQL (alignement LOT-1B1)

Les identifiants PostgreSQL de ce lot **MUST** suivre la convention déjà fusionnée pour `integration_connections` (LOT-1B1) :

- colonnes **camelCase** quotées (`"companyId"`, `"connectionId"`, …) — **MUST NOT** `snake_case` (`company_id`) ;
- `DateTime` Prisma → `TIMESTAMP(3)` (comme LOT-1B1) ;
- FK Envelope → Connection : colonnes `("connectionId", "companyId")` → `integration_connections("id", "companyId")` (composite déjà figé en 1B1 via `@@unique([id, companyId])`) ;
- champ Prisma / contrat LOT-1A : `connectionId` (réf. `IntegrationConnection.id`) — **MUST NOT** renommer en `integrationConnectionId`.

### 3.1 Colonnes

| Colonne | Type Prisma | Type SQL | Null | Défaut | Public / technique | Mutabilité |
|---------|-------------|----------|------|--------|--------------------|------------|
| `id` | `String` `@id` `@default(cuid())` | `TEXT` PK | non | cuid | public | immuable après insert |
| `companyId` | `String` | `TEXT` | non | — | public | immuable |
| `connectionId` | `String` | `TEXT` | non | — | public | immuable |
| `connectorType` | `String` | `TEXT` | non | — | public (snapshot) | immuable |
| `externalId` | `String` | `TEXT` | non | — | public | immuable |
| `idempotencyKey` | `String` | `TEXT` | non | — | public | immuable |
| `receivedAt` | `DateTime` | `TIMESTAMP(3)` | non | fourni à la création | public | immuable (1ʳᵉ écriture) |
| `payloadRef` | `String` | `TEXT` | non | — | public opaque | immuable |
| `contentType` | `String` | `TEXT` | non | — | public | immuable |
| `schemaVersion` | `String` | `TEXT` | non | `"1.0.0"` | public | immuable |
| `lifecycleStatus` | enum `EnvelopeLifecycleStatus` | enum PG | non | `RECEIVED` | public | **seule** colonne métier mutable |
| `rawPayloadHash` | `String?` | `TEXT` | oui | — | public optionnel | immuable |
| `createdAt` | `DateTime` | `TIMESTAMP(3)` | non | `now()` | technique | immuable |
| `updatedAt` | `DateTime` `@updatedAt` | `TIMESTAMP(3)` | non | auto | technique | auto |

### 3.2 Enum lifecycle (Prisma / SQL)

Nom : `EnvelopeLifecycleStatus`  
Valeurs **MUST** : `RECEIVED`, `NORMALIZED`, `NORMALIZE_FAILED`, `ROUTED`, `NO_MATCH`, `AMBIGUOUS`, `DISPATCHED`, `DISCARDED`, `ARCHIVED`  
(Alignées LOT-1A `ENVELOPE_LIFECYCLE_STATUSES`.)

### 3.3 Uniques (MUST — ordre des champs figé)

Noms alignés sur le style LOT-1B1 (`integration_connections_id_companyId_key`).

| Contrainte SQL (nom) | Colonnes SQL |
|----------------------|--------------|
| `integration_inbound_envelopes_id_companyId_key` | `("id", "companyId")` |
| `integration_inbound_envelopes_id_companyId_connectionId_key` | `("id", "companyId", "connectionId")` |
| `integration_inbound_envelopes_idempotency_key` | `("companyId", "connectionId", "idempotencyKey")` |

Prisma :

- `@@unique([id, companyId], map: "integration_inbound_envelopes_id_companyId_key")`
- `@@unique([id, companyId, connectionId], map: "integration_inbound_envelopes_id_companyId_connectionId_key")`
- `@@unique([companyId, connectionId, idempotencyKey], map: "integration_inbound_envelopes_idempotency_key")`

### 3.4 Indexes (MUST)

| Index SQL (nom proposé) | Colonnes SQL |
|-------------------------|--------------|
| `integration_inbound_envelopes_companyId_lifecycleStatus_idx` | `("companyId", "lifecycleStatus")` |
| `integration_inbound_envelopes_companyId_connectionId_receivedAt_idx` | `("companyId", "connectionId", "receivedAt")` |
| `integration_inbound_envelopes_companyId_connectionId_externalId_idx` | `("companyId", "connectionId", "externalId")` |

`externalId` **MUST NOT** être unique seul.

### 3.5 Relations et onDelete

| Relation | Fields → References | onDelete |
|----------|---------------------|----------|
| `company` → `Company` | `companyId` → `id` | **Cascade** |
| `connection` → `IntegrationConnection` | `[connectionId, companyId]` → `[id, companyId]` | **Cascade** |
| `normalizedInbounds` → `NormalizedInbound[]` | (inverse) | descendants via FK Normalized |

Effet collatéral additif LOT-1B1 : relation inverse `inboundEnvelopes InboundEnvelope[]` sur `IntegrationConnection`.

### 3.6 Suppression applicative

Le repository **MUST NOT** exposer de delete physique. La suppression n’intervient que via CASCADE SQL (Company / Connection).

---

## 4. Modèle NormalizedInbound

| Attribut | Valeur figée |
|----------|--------------|
| Nom Prisma | `NormalizedInbound` |
| Nom SQL | `integration_normalized_inbounds` |

### 4.1 Colonnes

| Colonne | Type Prisma | Type SQL | Null | Défaut | Public / technique | Mutabilité |
|---------|-------------|----------|------|--------|--------------------|------------|
| `id` | `String` `@id` `@default(cuid())` | `TEXT` PK | non | cuid | public | immuable |
| `companyId` | `String` | `TEXT` | non | — | public | immuable |
| `connectionId` | `String` | `TEXT` | non | — | public | immuable |
| `envelopeId` | `String` | `TEXT` | non | — | public | immuable |
| `family` | enum `InboundFamily` | enum PG | non | — | public | immuable |
| `occurredAt` | `DateTime` | `TIMESTAMP(3)` | non | — | public | immuable |
| `receivedAt` | `DateTime` | `TIMESTAMP(3)` | non | — | public | immuable |
| `normalizedHash` | `String` | `TEXT` | non | — | public | immuable |
| `artifactRefs` | `String[]` | `TEXT[]` | non | `{}` / `[]` | public opaque | immuable |
| `schemaVersion` | `String` | `TEXT` | non | `"1.0.0"` | public | immuable |
| `message` | `Json` | `JSONB` | non | — | public (MESSAGE) | immuable |
| `createdAt` | `DateTime` | `TIMESTAMP(3)` | non | `now()` | technique | immuable |
| `updatedAt` | `DateTime` `@updatedAt` | `TIMESTAMP(3)` | non | auto | technique | auto |

### 4.2 Enum family

Nom : `InboundFamily`  
Valeur V1 **MUST** : `MESSAGE` uniquement (alignée LOT-1A).  
Extension future = migration additive d’enum + révision contrat — hors ce lot.

### 4.3 Uniques (MUST)

| Contrainte SQL (nom) | Colonnes SQL |
|----------------------|--------------|
| `integration_normalized_inbounds_id_companyId_key` | `("id", "companyId")` |
| `integration_normalized_inbounds_envelope_version_key` | `("envelopeId", "companyId", "family", "schemaVersion")` |

Prisma :

- `@@unique([id, companyId], map: "integration_normalized_inbounds_id_companyId_key")`
- `@@unique([envelopeId, companyId, family, schemaVersion], map: "integration_normalized_inbounds_envelope_version_key")`

### 4.4 Indexes (MUST)

| Index SQL (nom proposé) | Colonnes SQL |
|-------------------------|--------------|
| `integration_normalized_inbounds_companyId_connectionId_receivedAt_idx` | `("companyId", "connectionId", "receivedAt")` |
| `integration_normalized_inbounds_companyId_envelopeId_idx` | `("companyId", "envelopeId")` |

### 4.5 Relations et suppression

| Relation | Fields → References (ordre strict) | onDelete |
|----------|--------------------------------------|----------|
| `company` → `Company` | `companyId` → `id` | **Cascade** |
| `envelope` → `InboundEnvelope` | `[envelopeId, companyId, connectionId]` → `[id, companyId, connectionId]` | **Cascade** |

**MUST NOT** : FK directe NormalizedInbound → `IntegrationConnection`.

Repository **MUST NOT** exposer delete / update métier. Suppression = CASCADE uniquement.

### 4.6 Contenu `message`

- **MUST** être un objet JSON valide représentant un `NormalizedMessage` LOT-1A après validation Zod.
- **MUST NOT** contenir de binaire, MIME brut, ni payload Envelope inline.

---

## 5. Invariants tenant et relationnels

Les règles suivantes sont **normatives** :

1. **MUST NOT** : aucune opération repository n’accepte un accès par `id` seul.
2. **MUST** : tout `find*` / `create*` / `transitionLifecycle` / `list*` est filtré par `companyId` (tenant).
3. **MUST** : une Envelope appartient à une `IntegrationConnection` du **même** `companyId` (FK composite Envelope → Connection).
4. **MUST** : un `NormalizedInbound` porte le **même** `companyId` et le **même** `connectionId` que son `InboundEnvelope`.
5. **MUST** : la FK ternaire  
   `NormalizedInbound("envelopeId", "companyId", "connectionId") → InboundEnvelope("id", "companyId", "connectionId")`  
   garantit (4) **au niveau base** : un drift de `connectionId` est refusé par PostgreSQL.
6. **MUST NOT** : l’isolation multi-tenant ne repose **pas uniquement** sur le code repository ou sur Prisma client ; les contraintes SQL sont obligatoires.

---

## 6. Idempotence Envelope

### 6.1 Clé

- Clé d’idempotence **MUST** : `(companyId, connectionId, idempotencyKey)`
- Contrainte SQL **MUST** s’appeler : `integration_inbound_envelopes_idempotency_key`
- `externalId` **MUST** rester non unique (indexé seulement)

### 6.2 Compatibilité — `receivedAt`

`receivedAt` est l’horodatage de **réception Platform** (contrat LOT-1A / SPEC parent).  
Un retry légitime peut produire un horodatage mur différent.  
**MUST NOT** : inclure `receivedAt` dans la comparaison de compatibilité d’idempotence.  
La première écriture conserve sa valeur.

### 6.3 Attributs immuables comparés (MUST)

À l’égalité stricte champ à champ :

- `companyId`
- `connectionId`
- `connectorType`
- `externalId`
- `payloadRef`
- `contentType`
- `schemaVersion`
- `rawPayloadHash` — sémantique : absent/`null` côté stocké ≡ absent côté candidat ; présent vs absent = incompatibilité

**MUST NOT** comparer pour la compatibilité : `id`, `lifecycleStatus`, `receivedAt`, `createdAt`, `updatedAt`.

### 6.4 Algorithme `createIdempotent` (MUST)

1. Valider l’input (mapper) et résoudre `connectorType` depuis `IntegrationConnection` (§9).
2. Tenter l’`INSERT` avec `lifecycleStatus = RECEIVED`.
3. En cas de succès : mapper vers le contrat LOT-1A et retourner.
4. En cas d’erreur Prisma `P2002` :
   - **En interne uniquement**, identifier si la violation porte sur `integration_inbound_envelopes_idempotency_key`  
     (via `meta.constraint` et/ou ensemble de champs `meta.target` correspondant à `{companyId, connectionId, idempotencyKey}`).
   - **Si et seulement si** c’est cette contrainte :
     - relire l’Envelope `(companyId, connectionId, idempotencyKey)` ;
     - si immutables compatibles → retourner l’existante ;
     - sinon → `IDEMPOTENCY_CONFLICT`.
   - **Tout autre** `P2002` → `PERSISTENCE` (MUST NOT traiter comme retry compatible).
5. Autres erreurs Prisma → `PERSISTENCE`.
6. **MUST NOT** exposer `meta` / messages Prisma dans l’erreur publique.

---

## 7. Versionnement NormalizedInbound

- Écriture **MUST** être insert-only.
- **MUST NOT** : fusion, replace, update métier, retour silencieux de l’existante sur conflit de version.
- Contrainte SQL de version **MUST** s’appeler : `integration_normalized_inbounds_envelope_version_key`
- Colonnes SQL : `("envelopeId", "companyId", "family", "schemaVersion")`
- Violation de cette contrainte **MUST** → `NORMALIZED_VERSION_CONFLICT`
- Tout autre incident Prisma (autres uniques, FK, infra) **MUST** → `PERSISTENCE` (sauf `VALIDATION` / `PAYLOAD_TOO_LARGE` détectés avant Prisma)

Identification interne du `P2002` de version : même discipline que §6.4 (constraint name / target fields), sans exposition publique.

---

## 8. Lifecycle atomique

### 8.1 Signature conceptuelle (MUST)

```
transitionLifecycle({
  companyId: string
  envelopeId: string
  expectedStatuses: EnvelopeLifecycle[]  // non vide
  targetStatus: EnvelopeLifecycle
}) → InboundEnvelope
```

### 8.2 Garanties repository (MUST)

- `expectedStatuses` non vide ; sinon `VALIDATION`
- Compare-and-set atomique :  
  `UPDATE … WHERE id = envelopeId AND companyId = :companyId AND lifecycleStatus IN expectedStatuses SET lifecycleStatus = targetStatus`
- Filtre tenant obligatoire
- Si `count = 0` : relecture par `(companyId, envelopeId)`  
  - absent → `NOT_FOUND`  
  - présent → `LIFECYCLE_CONFLICT`
- **MUST NOT** : update générique / libre des autres colonnes

### 8.3 Hors périmètre (MUST NOT dans LOT-1B2)

Le **graphe métier** des transitions autorisées (politique d’orchestration) est **hors LOT-1B2**.  
Le repository est une primitive CAS uniquement ; il n’enforce pas « RECEIVED → DISPATCHED interdit ».

---

## 9. connectorType snapshot

- À la création Envelope, `connectorType` **MUST** être copié depuis `IntegrationConnection.connectorType` du couple `(companyId, connectionId)`.
- Un appelant externe **MUST NOT** être traité comme autorité de `connectorType`.
- Si l’input transporte un `connectorType` et qu’il diffère du snapshot Connection → `VALIDATION`.
- Après insert, `connectorType` **MUST** rester immuable (y compris si la Connection change ultérieurement).

---

## 10. JSONB et limite de taille

Règles **MUST** pour la colonne `message` uniquement :

1. Validation Zod (`normalizedMessageSchema` / équivalent LOT-1A) **avant** sérialisation.
2. `JSON.stringify(message)`.
3. Échec de sérialisation → `VALIDATION` (MUST NOT atteindre Prisma).
4. Mesure : `Buffer.byteLength(serialized, "utf8")`.
5. Limite exacte : **262144** octets (256 KiB).
6. Dépassement → `PAYLOAD_TOO_LARGE`.
7. **MUST NOT** appeler Prisma avant validation complète (Zod + sérialisation + taille).

Aucun binaire dans NormalizedInbound.

---

## 11. artifactRefs

| Règle | Norme LOT-1B2 persistence |
|-------|---------------------------|
| Nature | Tableau opaque d’identifiants (`TEXT[]`) |
| Vide | **Autorisé** (`[]`) |
| Éléments | **MUST** être non vides (`min` length 1) — aligné LOT-1A `opaqueIdSchema` |
| Cardinalité max | **100** |
| Doublons | **MUST** être rejetés → `VALIDATION` |
| FK | **Aucune** |
| Table Artifact | **Aucune** |
| Déduplication silencieuse | **MUST NOT** |

LOT-1A ne fixe pas de borne de cardinalité normative sur `artifactRefs`.  
La borne **100** est une **règle locale du mapper / input persistence** de LOT-1B2.  
**MUST NOT** modifier les contrats LOT-1A dans ce lot. Une révision normative LOT-1A est reportée (§18).

Validation artifactRefs **MUST** survenir avant Prisma.

---

## 12. API repositories

**MUST NOT** : repository générique unique, delete physique, update libre.

### 12.1 `InboundEnvelopeRepository`

| Opération | Signature conceptuelle |
|-----------|------------------------|
| `createIdempotent` | `(input: CreateInboundEnvelopeInput) → InboundEnvelope` |
| `findById` | `(companyId, id) → InboundEnvelope` |
| `findByIdempotencyKey` | `(companyId, connectionId, idempotencyKey) → InboundEnvelope` |
| `listByConnection` | `(companyId, connectionId, filters?: { lifecycleStatus? }) → InboundEnvelope[]` |
| `transitionLifecycle` | `( { companyId, envelopeId, expectedStatuses, targetStatus } ) → InboundEnvelope` |

### 12.2 `NormalizedInboundRepository`

| Opération | Signature conceptuelle |
|-----------|------------------------|
| `create` | `(input: CreateNormalizedInboundInput) → NormalizedInbound` |
| `findById` | `(companyId, id) → NormalizedInbound` |
| `findByEnvelopeVersion` | `(companyId, envelopeId, family, schemaVersion) → NormalizedInbound` |
| `listByEnvelope` | `(companyId, envelopeId) → NormalizedInbound[]` |

Emplacement attendu (aligné 1B1) : `src/lib/integration/persistence/**` — Prisma **MUST NOT** être importé hors de ce périmètre (gate architecture existante).

---

## 13. Taxonomie d’erreurs

Codes publics stables **MUST** être exactement :

| Code | Usage |
|------|--------|
| `VALIDATION` | Zod, connectorType mismatch, `expectedStatuses` vide, sérialisation JSON impossible, artifactRefs invalides, row corrompue au mapping |
| `NOT_FOUND` | Envelope / Normalized / Connection absents pour le tenant |
| `PERSISTENCE` | FK, infra, `P2002` non ciblés, incidents non classifiés |
| `IDEMPOTENCY_CONFLICT` | Même clé d’idempotence, immutables incompatibles |
| `LIFECYCLE_CONFLICT` | CAS : Envelope présente, statut ∉ `expectedStatuses` |
| `PAYLOAD_TOO_LARGE` | `message` > 262144 octets UTF-8 |
| `NORMALIZED_VERSION_CONFLICT` | Violation `integration_normalized_inbounds_envelope_version_key` |

**MUST NOT** exposer metadata, codes provider, ou messages Prisma aux couches supérieures.

Préfixe d’implémentation recommandé (non contractuel public) : `INTEGRATION_INBOUND_*` — le **code logique** ci-dessus reste la norme de taxonomie.

---

## 14. Migration

### 14.1 Principes

- **MUST** : additive uniquement
- **MUST NOT** : `DROP`, rename destructif, bridge, table Artifact, modification destructrice LOT-1B1
- Ordre **MUST** :
  1. Enums (`EnvelopeLifecycleStatus`, `InboundFamily`)
  2. Table `integration_inbound_envelopes` + uniques nommées + indexes + FK Company + FK composite Connection
  3. Table `integration_normalized_inbounds` + uniques nommées + indexes + FK Company + FK ternaire Envelope
  4. Relation inverse Prisma sur `IntegrationConnection` (additif)

### 14.2 Noms SQL figés (minimum)

| Objet | Nom SQL |
|-------|---------|
| Unique ternaire Envelope (cible FK) | `integration_inbound_envelopes_id_companyId_connectionId_key` |
| Unique tenant Envelope | `integration_inbound_envelopes_id_companyId_key` |
| Idempotence Envelope | `integration_inbound_envelopes_idempotency_key` |
| Unique tenant Normalized | `integration_normalized_inbounds_id_companyId_key` |
| Version Normalized | `integration_normalized_inbounds_envelope_version_key` |
| FK ternaire Normalized → Envelope | `integration_normalized_inbounds_envelope_tenant_connection_fkey` |
| FK Envelope → Connection (composite) | `integration_inbound_envelopes_connectionId_companyId_fkey` |

FK Envelope → `IntegrationConnection` (aligné unique 1B1) :  
`("connectionId", "companyId") REFERENCES "integration_connections" ("id", "companyId") ON DELETE CASCADE`

Colonnes FK ternaire Normalized → Envelope :  
`("envelopeId", "companyId", "connectionId") REFERENCES "integration_inbound_envelopes" ("id", "companyId", "connectionId") ON DELETE CASCADE`

---

## 15. Plan de tests

### 15.1 Unitaires (MUST)

- Mapper Envelope (round-trip, dates ISO↔Date, `rawPayloadHash` null/absent)
- Mapper Normalized (round-trip, JSONB `message`)
- Dates / nullables
- Taille UTF-8 : frontières 262144 / 262145 → OK / `PAYLOAD_TOO_LARGE`
- `JSON.stringify` impossible → `VALIDATION` (sans Prisma)
- `artifactRefs` : `[]` OK ; élément vide ; doublons ; >100 → `VALIDATION`
- Comparaison immutables ; `receivedAt` ignoré
- Classification ciblée `P2002` idempotence vs autre → chemins distincts
- Classification `P2002` version → `NORMALIZED_VERSION_CONFLICT`

**MUST NOT** exiger une suite de tests du graphe métier de transitions dans ce lot.

### 15.2 PostgreSQL (MUST)

- FK composite Envelope → Connection
- FK ternaire Normalized → Envelope
- Drift `connectionId` Normalized ≠ Envelope **refusé** par la DB
- `createIdempotent` concurrent (`Promise.all` réel) → une seule ligne
- Collision compatible → même Envelope
- Collision incompatible → `IDEMPOTENCY_CONFLICT`
- `P2002` hors contrainte d’idempotence → `PERSISTENCE` (sans faux retry compatible)
- Cross-tenant → `NOT_FOUND`
- CAS lifecycle succès
- Concurrence CAS → un succès + un `LIFECYCLE_CONFLICT`
- Versions Normalized distinctes OK
- Doublon version → `NORMALIZED_VERSION_CONFLICT`
- JSONB round-trip
- CASCADE Connection → Envelope → Normalized
- Absence d’orphelins Normalized après cascade

Garde URL de test safe (pattern LOT-1B1) **SHOULD** être réutilisée.

---

## 16. Critères de fermeture LOT-1B2

Le lot **MUST NOT** être déclaré fermé tant que **tous** les points suivants ne sont pas satisfaits :

1. SPEC respectée (ce document)
2. Migration appliquée sur PostgreSQL 16 jetable
3. Tests unitaires verts
4. Tests PostgreSQL verts
5. Concurrence réelle exercée (pas seulement séquentielle)
6. `tsc` vert
7. `prisma validate` vert
8. Gate architecture (imports Prisma) verte
9. Revue indépendante approuvée
10. Commit et PR **strictement ciblés** LOT-1B2
11. **LOT-1C non commencé** avant merge de LOT-1B2

---

## 17. Risques acceptés

| Risque | Acceptation |
|--------|-------------|
| Redondance `@@unique([id, companyId])` et `@@unique([id, companyId, connectionId])` | Volontaire : sélecteur tenant + cible FK ternaire |
| Borne `artifactRefs` max 100 locale persistence | En attendant révision LOT-1A |
| CAS sans politique métier de graphe | Reportée au service d’orchestration |
| CASCADE destructif Connection/Company | Aligné décision d’architecture imposée ; rétention Ops hors lot |
| Matching `P2002` via métadonnées Prisma | Noms SQL figés + tests ; **fallback MUST** → `PERSISTENCE` si classification ambiguë |

---

## 18. Décisions explicitement reportées

- Persistance `InboundArtifact` / workers download
- Replay explicite et audit d’attempts
- Historique des transitions lifecycle
- API `findByExternalId`
- Politique complète des transitions (graphe domaine/service)
- Révision normative LOT-1A pour borne `artifactRefs`
- **LOT-1C** bridge mail / shadow

---

## Historique

| Version | Date | Statut |
|---------|------|--------|
| 0.1.0 | 2026-07-27 | DRAFT FOR IMPLEMENTATION |
| 0.1.1 | 2026-08-01 | DRAFT — alignement doc SQL camelCase / LOT-1B1 (R1) ; aucune règle métier changée |
