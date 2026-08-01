# PLAN-INTEGRATION-PLATFORM-001 — LOT-2 Runtime Routing

## 1. Statut et objectif

| Champ | Valeur |
|-------|--------|
| Statut | **DRAFT R1 — READY FOR IMPLEMENTATION PLAN** |
| Plan parent | PLAN-INTEGRATION-PLATFORM-001 |
| Lot | LOT-2 — Runtime Routing (Sources / Rules / Bindings / Router / Shadow matching) |
| Alignement SPEC parent | **M2 — Parité Matching** |
| Dépendances | LOT-1A, LOT-1B1, LOT-1B2, LOT-1C fusionnés sur `main` |
| Implémentation | **Interdite** tant que le plan d’implémentation n’est pas GO |
| Revue architecture | R1 — corrections intégrées (baseline L1, hash config, lifecycle shadow, BODY local, barrière LOT-3) |

### 1.1 Objectif

Atteindre la **Parité Matching** :

```text
NormalizedInbound (MESSAGE, déjà produit — typiquement via LOT-1C)
  → Tenant Router (Sources + Rules + Bindings, même companyId)
  → RoutingDecision (persistée, shadow uniquement)
  → [shadow] comparaison L1 legacy ↔ Router (sans effet métier)
  → [service] simulateur de routage (sans UI, sans persistance durable par défaut)
```

Contraintes non négociables :

- Le Router est la **seule** autorité de routage Platform (SPEC parent §12).
- **Aucun Draft**, aucune `PipelineAdmission`, aucun dispatch, aucun worker métier en écriture.
- Un `outcome = MATCH` en LOT-2 est **purement shadow** — **MUST NOT** déclencher d’admission.
- **Aucun second poll / fetch Gmail** — le Router lit uniquement le `NormalizedInbound` déjà disponible.
- Legacy reste **seule** autorité métier tant que le shadow matching est actif.
- Multi-tenant strict : aucune évaluation cross-`companyId`.
- Booking inchangé.
- En shadow LOT-2, l’Envelope **reste** `NORMALIZED` (aucun CAS de routage).

### 1.2 Sources normatives

| Source | Rôle |
|--------|------|
| `docs/integration-platform-001.spec.md` | Matching §7 ; Router §12–17 ; Shadow §20/§28 ; lifecycle §23 ; M2 |
| `docs/integration-platform-001.impl-plan.md` | Découpage §4 ; LOT-2 §13 ; bornes §13.6 ; flags |
| `docs/integration-platform-001-security.spec.md` | Redaction ; secrets hors Router ; AuthZ |
| `docs/integration-platform-001-lot-1c-mail-shadow.spec.md` | Frontière Parité Runtime ; un seul poll ; exclusions |
| Contrats LOT-1A | `RoutingDecision`, `NormalizedInbound` / `NormalizedMessage`, outcomes — **autorité de forme** |
| Persistence LOT-1B2 | Envelope / Normalized — **autorité d’accès** amont |

Cette SPEC **MUST NOT** republier intégralement les schémas Zod LOT-1A. Elle fige le **comportement runtime routing**, les entités de configuration, et les règles de persistance LOT-2.

### 1.3 Décisions architecturales figées (Discovery + R1)

| # | Décision |
|---|----------|
| D1 | `NormalizedMessage.subject` fait partie du modèle normalisé **utilisé** par LOT-2. |
| D2 | `subject` reste **optionnel** sur le contrat LOT-1A. |
| D3 | Lorsqu’il est fourni, `subject` **MUST** être normalisé, **borné**, et **persistant** dans `NormalizedInbound.message`. |
| D4 | `SUBJECT_KEYWORD` **MAY** matcher uniquement contre `message.subject` normalisé présent. |
| D5 | `subject` **MUST NEVER** être journalisé en clair ; tout log passe par l’API de redaction Integration. |
| D6 | Absence de `subject` est un **cas valide** (pas une erreur de routage en soi). |
| D7 | **Aucun** second fetch Gmail pour obtenir subject/body. |
| D8 | `BODY_KEYWORD` ne matche **que** via un **port local explicite** sur corps déjà matérialisé (§12). |
| D9 | Baseline legacy shadow = **L1** uniquement (§14). |
| D10 | `routingConfigurationVersion` = **hash canonique** uniquement (§13). |
| D11 | Shadow LOT-2 : Envelope **reste** `NORMALIZED` ; pas de CAS routage (§14.7). |
| D12 | Aucun consommateur d’admission avant LOT-3 + flags propres (§4.2). |
| D13 | Scope `connectionId` = **PipelineBinding uniquement** (§7). |
| D14 | Enrichissement `subject` amont = sous-étape nommée **LOT-2A** (§4.1.1). |

---

## 2. Périmètre inclus (MUST)

1. Contrats / formes de configuration : `InboundSource`, `InboundSourceRule`, `PipelineBinding` (Zod + persistence).
2. Persistence additive Prisma/SQL pour Sources, Rules, Bindings, `RoutingDecision`.
3. Runtime **Tenant Router** : entrée `NormalizedInbound` → `RoutingDecision` (§8).
4. Algorithme de matching V1 (§10) conforme SPEC parent §7.
5. Sémantique `SUBJECT_KEYWORD` / `BODY_KEYWORD` / identités (§11–§12).
6. `routingConfigurationVersion` hash canonique (§13).
7. Shadow comparison matching L1 legacy ↔ Router (§14) — **sans** Draft.
8. Observabilité et métriques de parity (§16).
9. Flags fail-closed dédiés matching (§17).
10. Simulateur de routage **service** (pas d’UI) (§20.4).
11. Sous-étape **LOT-2A** : enrichissement `subject` sans second fetch (§4.1.1).
12. Tests unitaires, PostgreSQL, non-régression, isolation tenant (§20).
13. Critères MODULE CLOSED (§22).

---

## 3. Exclusions (MUST NOT)

| Domaine | Exclusion |
|---------|-----------|
| `PipelineAdmission` runtime / admission / Draft / dispatch | **LOT-3** |
| Consommation d’une `RoutingDecision` pour admettre | Interdit en LOT-2 (§4.2) |
| Fan-out multi-pipelines | SPEC parent §17 — hors V1 |
| Familles DOCUMENT / EVENT | Annexe A |
| UI admin / simulateur UI | **LOT-6** |
| Second poll / fetch Gmail / download PJ / worker content | Interdit (LOT-1C + D7–D8) |
| Booking | `src/lib/booking/**` |
| Modification contrats LOT-1A | Sauf GO explicite (subject déjà optionnel) |
| Modification persistence LOT-1B1/1B2 destructive | Interdit |
| CAS Envelope vers `ROUTED` / `NO_MATCH` / `AMBIGUOUS` | **Hors LOT-2 shadow** (§14.7) |
| Secrets Platform / OAuth | SECURITY IMPLEMENTATION READY |
| Utiliser `connectorType` comme critère de matching | SPEC parent — traçabilité bordure uniquement |
| Compteur monotone comme autorité d’idempotence routing | Interdit (D10) |

---

## 4. Frontières avec LOT-1C et LOT-3

### 4.1 LOT-1C (Parité Runtime) — amont

| LOT-1C | LOT-2 |
|--------|-------|
| Produit Envelope + Normalized MESSAGE | Consomme Normalized déjà `NORMALIZED` |
| Shadow = projection Envelope | Shadow = **comparaison matching** |
| Flags mail shadow | Flags matching **distincts** (§17) |
| Peut omettre `subject` dans le DTO bridge | Si `subject` absent → `SUBJECT_KEYWORD` ne matche pas (§11) |
| Un seul poll | **MUST** préserver : Router n’ajoute aucun poll |
| Lifecycle → `NORMALIZED` | **MUST** rester `NORMALIZED` après routage shadow |

#### 4.1.1 Sous-étape LOT-2A — Enrichissement `subject`

L’enrichissement du chemin LOT-1C / normalizer MESSAGE pour **renseigner** `subject` lorsqu’il est déjà disponible dans le résultat du poll (DTO / payload déjà acquis) est une **sous-étape explicitement nommée LOT-2A**.

| Règle LOT-2A | Norme |
|--------------|--------|
| Périmètre | Mapper / normalizer MESSAGE uniquement |
| `subject` | Optionnel ; borné ; normalisé (trim, NFC) ; persistant dans `message` |
| Fetch | **MUST NOT** second fetch Gmail ni I/O distante |
| Logs | **MUST** redaction ; jamais `subject` en clair |
| Hors LOT-2A | Router, Sources/Rules, shadow parity, simulateur UI |

Absence de `subject` après LOT-2A reste **valide** (D6).

### 4.2 LOT-3 (Parité Drafts) — aval — barrière normative

| LOT-2 | LOT-3 |
|-------|-------|
| Produit `RoutingDecision` (shadow) | Seul lot autorisé à **consommer** une décision pour admettre |
| N’appelle **jamais** `admit` | Produit `PipelineAdmission` + Draft sous flags LOT-3 |
| `MATCH` = décision technique shadow | `MATCH` + flags LOT-3 = seul chemin d’admission Platform |

**Barrière LOT-3 (MUST) :**

1. Aucune `RoutingDecision` produite en LOT-2 **MUST NOT** déclencher admission, création Draft, dispatch, ni worker métier.
2. **Aucun consommateur d’admission** n’est autorisé tant que LOT-3 n’est pas livré **et** que ses flags propres ne l’autorisent pas.
3. En LOT-2, `outcome = MATCH` reste **purement shadow**.

### 4.3 Sens des dépendances

```text
Acquisition / LOT-1C (+ LOT-2A subject)  →  Integration (Normalized, lifecycle NORMALIZED)
Integration Router                       →  Sources/Rules/Bindings (même companyId)
Integration Router                       →  RoutingDecision (persist, shadow)
LOT-3 (+ flags)                          →  RoutingDecision + Normalized  →  PipelineAdmission
```

**Interdit :** Integration Router → Acquisition métier ; Router → Booking ; Router → Draft ; Router → CAS Envelope routage (LOT-2).

---

## 5. InboundSource

### 5.1 Rôle

Source logique **métier** configurable par Company — **données**, pas un ConnectorType.

### 5.2 Attributs conceptuels (MUST)

| Champ | Règle |
|-------|--------|
| `id` | Opaque |
| `companyId` | Tenant — immuable |
| `displayName` | Non vide, borné (§15.4) |
| `enabled` | bool — `false` ⇒ ignorée par le Router |
| `schemaVersion` | Platform V1 |
| timestamps | `createdAt` / `updatedAt` |

**MUST NOT** : champ `connectionId` / scope Connection sur `InboundSource` (D13).

### 5.3 Intégrité

- Source `enabled=true` **MUST** avoir **≥ 1** rule IDENTITÉ `enabled=true` (sinon refus admin / validation).
- Appartient à **une seule** Company.
- **MUST NOT** encoder un Provider ou SDK.

---

## 6. InboundSourceRule

### 6.1 Classes V1 (fermées)

#### IDENTITÉ (obligatoire pour Source active)

| `type` | Match sur |
|--------|-----------|
| `SENDER_EMAIL` | `message.sender.email` normalisé (si présent) |
| `SENDER_DOMAIN` | `message.sender.domain` ou domaine dérivé de l’email (si présent) |

#### QUALIFICATIVE

| `type` | Match sur |
|--------|-----------|
| `SUBJECT_KEYWORD` | `message.subject` normalisé — **§11** |
| `BODY_KEYWORD` | Corps local via port explicite — **§12** |
| `RECIPIENT_EMAIL` | Destinataire normalisé ; si champ absent ⇒ rule **ne matche pas** |

### 6.2 Attributs conceptuels

| Champ | Règle |
|-------|--------|
| `id`, `companyId`, `sourceId` | Opaque ; tenant aligné Source |
| `type` | Enum fermée ci-dessus |
| `value` | Valeur brute admin (jamais utilisée pour matcher) |
| `normalizedValue` | **Seule** valeur de comparaison (§ matching) |
| `enabled` | bool |
| `schemaVersion` | V1 |

### 6.3 Normalisation serveur (à la persistance admin)

Alignée SPEC parent §15 :

| Domaine | Règle |
|---------|--------|
| Emails | trim + lowercase |
| Domaines | trim + lowercase ; comparaison **exacte** ; sous-domaines **non** matchés par défaut |
| Keywords | trim + lowercase + Unicode NFC ; longueur max = borne keyword (§15.4) |

**Interdits :** regex libre ; expressions exécutables ; keyword-only comme seule condition d’admission (identité toujours requise).

---

## 7. PipelineBinding

### 7.1 V1

```text
Une Source enabled  →  au plus un Binding actif  →  pipelineId = "consultations"
```

| Champ | Règle |
|-------|--------|
| `companyId`, `sourceId` | Tenant |
| `pipelineId` | Literal `consultations` (LOT-1A) |
| `enabled` | bool |
| `connectionId` | **Optionnel** — **seul** lieu du scope Connection (D13). Si présent, le Normalized **MUST** provenir de cette Connection |
| Unicité | Au plus **un** Binding `enabled=true` par `(companyId, sourceId)` |

Fan-out : **interdit**.

Si `connectionId` est présent : FK logique composite `(connectionId, companyId)` → `IntegrationConnection` (même tenant) — figée en plan d’implémentation.

---

## 8. Tenant Router

### 8.1 Entrées exclusives

- `NormalizedInbound` (famille MESSAGE, version V1)
- Sources / Rules / Bindings de **la même** `companyId`
- Snapshot de configuration versionné (`routingConfigurationVersion` = hash §13)

### 8.2 Sortie

Exactement une `RoutingDecision` **métier** par invocation aboutie (persistée selon §15), sous réserve d’idempotence (§9.2).

En LOT-2, cette décision est **shadow** : **MUST NOT** entraîner CAS Envelope ni admission (§4.2, §14.7).

### 8.3 Outcomes (MUST — LOT-1A)

| Outcome | Signification |
|---------|----------------|
| `MATCH` | Exactement une Source valide + Binding actif applicable — **shadow only** en LOT-2 |
| `NO_MATCH` | Aucune Source ne satisfait le matching |
| `NO_ACTIVE_BINDING` | Exactement une Source candidate mais aucun Binding actif |
| `AMBIGUOUS_SOURCE` | Plusieurs Sources valides — **pas** d’attribution auto |
| `ERROR` | Erreur technique de routage |

`DUPLICATE` n’est **pas** un outcome de remplacement sur rejeu — voir §9.2.

### 8.4 Interdits Router

- Créer Draft / appeler `PipelineAdmission` / dispatch / workers
- Connaître SDK / Connector Runtime / Provider
- Attribuer automatiquement en cas d’ambiguïté
- Lire Envelope brut (uniquement Normalized)
- Évaluer une autre `companyId`
- CAS lifecycle Envelope (`ROUTED`, `NO_MATCH`, `AMBIGUOUS`, …)
- Fetch distant / résolution distante de `bodyRef`

---

## 9. RoutingDecision

### 9.1 Forme

Autorité de forme : contrat LOT-1A `routingDecisionSchema`.

Champs normatifs rappelés (non republier Zod) :

- `id`, `companyId`, `normalizedInboundId`
- `outcome`, `matchedSourceIds`, `pipelineIds`
- `reasonCode` optionnel (machine-readable)
- `routingConfigurationVersion`
- `decidedAt`, `schemaVersion`

### 9.2 Idempotence (niveau 4 parent) et DUPLICATE

Clé logique : `(companyId, normalizedInboundId, routingConfigurationVersion)`.

| Situation | Comportement MUST |
|-----------|-------------------|
| Première décision pour la clé | Insert ; `outcome` métier = résultat du matching (`MATCH`, `NO_MATCH`, …) |
| Rejeu même clé | **MUST NOT** créer une nouvelle décision ; **retourner** la décision existante |
| Outcome persisté | **MUST** rester **inchangé** (pas d’écrasement par `DUPLICATE`) |
| Indication technique | Une indication `reused` / `idempotent` **MAY** être retournée **hors** contrat métier `RoutingDecision` (enveloppe d’appel / métadonnée runtime) |
| `DUPLICATE` | **MUST NOT** être persisté comme remplacement de l’outcome initial sur rejeu idempotent |

Si le contrat LOT-1A expose encore la valeur d’enum `DUPLICATE`, LOT-2 **MUST NOT** l’utiliser pour remplacer un outcome déjà stocké lors d’un rejeu de la même clé. Son usage éventuel hors ce cas est hors périmètre shadow V1 et exige GO explicite.

Changement de `routingConfigurationVersion` (nouveau hash) → **nouvelle** décision possible (historique conservé ; pas d’UPDATE de l’ancienne).

### 9.3 Persistance

Voir §15. Table dédiée multi-tenant.

---

## 10. Algorithme de matching

### 10.1 Préconditions

1. Flags matching ON pour le tenant (§17).
2. `NormalizedInbound` présent, famille MESSAGE, `schemaVersion` V1.
3. Configuration chargée pour `companyId` uniquement.
4. Envelope associée **reste** `NORMALIZED` (lecture seule lifecycle).

### 10.2 Ordre MUST

```text
1. Charger Sources enabled du tenant (+ Rules enabled, Bindings)
2. Calculer routingConfigurationVersion = hash canonique du snapshot (§13)
3. Pour chaque Source enabled :
   a. Identités : au moins une rule IDENTITÉ enabled matche (OR)
   b. Si ≥1 qualificatif enabled : au moins un qualificatif matche (OR)
      Sinon (aucun qualificatif enabled) : OK côté qualificatifs
   c. Scope Connection : si le Binding de la Source a connectionId,
      normalized.connectionId MUST égaler ce connectionId
      (pas de scope sur InboundSource)
4. Collecter Sources « candidates valides »
5. Décider outcome métier :
   - 0 candidate → NO_MATCH
   - >1 candidate → AMBIGUOUS_SOURCE (matchedSourceIds = toutes)
   - 1 candidate, Binding actif absent → NO_ACTIVE_BINDING
   - 1 candidate, Binding actif présent → MATCH
     (pipelineIds = [consultations], matchedSourceIds = [sourceId])
6. Persister ou réutiliser RoutingDecision (idempotence §9.2)
7. MUST NOT transitionner l’Envelope
```

### 10.3 Absence de champs Normalized

| Champ absent | Effet sur rules concernées |
|--------------|----------------------------|
| `sender.email` / domain | Rules IDENTITÉ correspondantes **ne matchent pas** |
| `subject` | `SUBJECT_KEYWORD` **ne matche pas** (D6) |
| Corps non lisible via port local | `BODY_KEYWORD` **ne matche pas** (D8) |
| Recipients | `RECIPIENT_EMAIL` **ne matche pas** |

Absence de champ **MUST NOT** provoquer `ERROR` à elle seule.

---

## 11. SUBJECT_KEYWORD

### 11.1 Règles

1. Comparaison **uniquement** sur `NormalizedMessage.subject` après normalisation keyword (trim, lowercase, NFC).
2. Match = `normalizedSubject.includes(normalizedValue)` (sous-chaîne).
3. Si `subject` **absent** ou vide après normalisation → rule **ne matche pas**.
4. **MUST NOT** déclencher un fetch distant pour obtenir le subject.
5. **MUST NOT** logger `subject` ni `normalizedValue` keyword en clair (redaction).

### 11.2 Bornes subject (lorsqu’il est fourni — LOT-2A / normalizer)

| Borne | Règle |
|-------|--------|
| Longueur max stockée | **512** caractères UTF-8 ; troncature documentée si dépassement à la normalisation amont |
| Normalisation | trim ; Unicode NFC ; pas de HTML brut |
| Persistance | Dans JSON `message` du NormalizedInbound (LOT-1B2) |

LOT-2 **MUST NOT** inventer un subject absent.

---

## 12. BODY_KEYWORD

### 12.1 Port local explicite

`BODY_KEYWORD` **MUST** s’évaluer **uniquement** via un **port local explicite** (nom figé en plan d’implémentation) qui :

- lit un corps **déjà matérialisé localement** pour ce Normalized / Envelope ;
- **MUST NOT** effectuer de fetch Gmail ;
- **MUST NOT** provoquer de second poll ;
- **MUST NOT** déclencher un worker content ;
- **MUST NOT** résoudre `bodyRef` par accès distant ;
- **MUST NOT** télécharger de pièce jointe.

### 12.2 Sémantique

1. Si le port local indique corps absent ou non lisible → rule **ne matche pas** (non satisfaite).
2. Sinon : match sous-chaîne sur corps normalisé (mêmes règles keyword que subject ; borne keyword §15.4).
3. **MUST NOT** logger le corps.
4. Aucune I/O distante dans le chemin Router.

---

## 13. routingConfigurationVersion

### 13.1 Définition

Chaîne opaque non vide = **hash canonique déterministe** du snapshot de configuration de routage du tenant utilisé pour une décision.

### 13.2 Algorithme (MUST — exclusif)

1. Sélectionner l’ensemble **actif pour le matching** :
   - Sources `enabled=true` du `companyId` ;
   - Rules `enabled=true` de ces Sources ;
   - Bindings `enabled=true` de ces Sources.
2. Construire un snapshot **ordonné** de façon stable (ordre total déterministe figé en IMPL, ex. tri par `id`).
3. Inclure **tous** les champs fonctionnels de matching, notamment :
   - Source : `id`, `enabled` (et tout champ futur affectant le matching) ;
   - Rule : `id`, `sourceId`, `type`, `normalizedValue`, `enabled` ;
   - Binding : `id`, `sourceId`, `pipelineId`, `enabled`, `connectionId` (scope, y compris absence).
4. **Exclure** du hash : timestamps purement techniques, `displayName` (sauf si un jour critère de matching — **non** en V1), `value` brute admin.
5. Calculer une empreinte cryptographique déterministe (algorithme exact figé en IMPL, ex. SHA-256 hex).
6. `routingConfigurationVersion` = représentation opaque de cette empreinte.

| Propriété | Norme |
|-----------|--------|
| Même configuration fonctionnelle | **Même** hash |
| Changement fonctionnel (create/update/enable/disable Source, Rule, Binding, `normalizedValue`, scope, `pipelineId`) | **Nouveau** hash |
| Compteur monotone | **MUST NOT** servir d’autorité d’idempotence ni de valeur de `routingConfigurationVersion` |

### 13.3 Cache et invalidation

- Cache tenant-scopé des Sources/Rules/Bindings **MUST** être invalidé à toute mutation config du tenant.
- Après invalidation, le prochain routage **MUST** recalculer le hash sur le snapshot frais.
- **MUST NOT** servir une décision avec un hash obsolète sciemment (snapshot chargé en début d’invocation = source de vérité pour cette invocation).

### 13.4 Tests de stabilité (MUST)

- Même fixture config → hash identique (N exécutions).
- Permutation d’ordre d’insert SQL sans changement fonctionnel → hash identique (grâce à l’ordonnancement canonique).
- Toggle `enabled` / changement `normalizedValue` / scope Binding → hash différent.
- Deux tenants configs égales structurellement → hashes **indépendants** (le snapshot est toujours scopé `companyId` ; inclusion de `companyId` dans le préambule du hash **MUST**).

### 13.5 Usage

- Stocké sur chaque `RoutingDecision`.
- Clé d’idempotence avec `normalizedInboundId` (§9.2).

---

## 14. Shadow comparison (Parité Matching)

### 14.1 Objectif

Comparer, pour un même inbound déjà normalisé, la décision **legacy L1** et la décision **Router**, **sans** side-effect métier.

### 14.2 Autorisé

- Lire Normalized + config tenant ;
- Exécuter Router → persister `RoutingDecision` ;
- Calculer outcome de parity ;
- Métriques / logs redacted.

### 14.3 Interdit

- Draft / Review / Conversion / workers écriture / dispatch ;
- Second poll / fetch ;
- Mutation eligibility legacy ;
- Impact sur stats métier Acquisition ;
- CAS Envelope hors `NORMALIZED` ;
- Admission / consommation LOT-3.

### 14.4 Baseline legacy — L1 exclusive

| Champ | Valeur figée |
|-------|--------------|
| Baseline | **L1** uniquement |
| Définition | Résultat d’admission / rejet du chemin `registerIncomingMessage` pour le même message (`externalId` / corrélation documentée) |
| Multiplicité | **Une seule** baseline active par environnement |
| Code stable | `parityBaselineCode = "L1_REGISTER_INCOMING_MESSAGE"` |

**MUST NOT** utiliser L2 (eligibility partenaire seule) comme baseline V1.

### 14.5 Table de projection legacy ↔ Router

Projection **normative** pour le calcul de parity (sans PII) :

| Résultat legacy L1 (classe) | Résultat Router | Outcome parity |
|-----------------------------|-----------------|----------------|
| Admit (message accepté / Draft créé ou équivalent admission positive) | `MATCH` | `PARITY_MATCH` |
| Reject (refus / non-admission métier) | `NO_MATCH` ou `NO_ACTIVE_BINDING` | `PARITY_REJECT` |
| Admit | non-`MATCH` (`NO_MATCH`, `NO_ACTIVE_BINDING`, …) | `PARITY_LEGACY_ONLY` |
| Reject | `MATCH` | `PARITY_ROUTER_ONLY` |
| Admit ou Reject déterministe | `AMBIGUOUS_SOURCE` ou `ERROR` | `PARITY_UNCOMPARABLE` |
| Indéterminé / erreur technique legacy | tout | `PARITY_UNCOMPARABLE` |
| Erreur technique de comparaison | — | `PARITY_ERROR` |

Notes :

- `PARITY_REJECT` = les deux côtés refusent (legacy reject ∧ Router non-match / no binding).
- `PARITY_MATCH` = les deux côtés acceptent au sens admission-equivalent.
- `AMBIGUOUS_SOURCE` et `ERROR` Router **MUST** produire `PARITY_UNCOMPARABLE` (pas un faux match/mismatch métier).
- Dimensions journalisées (opaques) : `companyId`, `normalizedInboundId` / `externalId` traçable, `parityBaselineCode`, ids sources, `reasonCode` stables si présents.

### 14.6 Divergences expliquées attendues (LOT-3 OFF)

Tant que LOT-3 est OFF, les divergences suivantes sont **expliquées** et **MUST** être documentées / filtrables dans les métriques (ne comptent pas dans le seuil « non expliquées = 0 ») :

| Code divergence | Cause |
|-----------------|--------|
| `EXPLAINED_MATCH_NO_DRAFT` | Router `MATCH` alors que l’autorité Draft n’a pas basculé (LOT-3 OFF) — observation shadow sans admission Platform |
| `EXPLAINED_SUBJECT_ABSENT` | Rule `SUBJECT_KEYWORD` active mais `subject` absent (pre-LOT-2A ou message sans subject) |
| `EXPLAINED_BODY_UNAVAILABLE` | Rule `BODY_KEYWORD` active mais port local sans corps |
| `EXPLAINED_QUALIFIER_GAP` | Legacy admit sur identité seule ; Router exige qualificatif enabled non satisfait |
| `EXPLAINED_CONFIG_NOT_SEEDED` | Pas encore de Source/Rule/Binding seedés pour le tenant |

Le plan d’implémentation **MUST** préciser comment `EXPLAINED_MATCH_NO_DRAFT` s’articule avec la table §14.5 (mode observation « decision-only » vs comptage brut) **sans** violer la barrière LOT-3.

### 14.7 Lifecycle Envelope en LOT-2 shadow

| Règle | Norme |
|-------|--------|
| Après routage shadow | Envelope **MUST** rester `NORMALIZED` |
| CAS vers `ROUTED` | **MUST NOT** |
| CAS vers `NO_MATCH` / `AMBIGUOUS` / branches routage | **MUST NOT** |
| Résultat shadow | Persisté **uniquement** dans `RoutingDecision` |
| Transitions Envelope de routage | **Reportées** au cutover / LOT-3 ou lot autoritatif ultérieur |

### 14.8 Critères avant LOT-3

Alignés IMPL §13.4 : zéro cross-tenant ; zéro mutation shadow ; zéro double fetch ; zéro double draft ; seuil divergences **non expliquées** = 0 ; rollback flags testé ; métriques disponibles ; `parityBaselineCode` journalisé.

---

## 15. Persistence et bornes

### 15.1 Tables (conceptuel — SQL figé en IMPL)

| Entité | Rôle |
|--------|------|
| `InboundSource` | Config Source |
| `InboundSourceRule` | Rules |
| `PipelineBinding` | Binding 1:1 → consultations (+ scope Connection optionnel) |
| `RoutingDecision` | Décisions Router (shadow en LOT-2) |

Convention SQL : alignée LOT-1B1/1B2 (camelCase quoté, `TIMESTAMP(3)`, `companyId` partout).

### 15.2 Uniques / index (MUST conceptuels)

- Source : `(id, companyId)` ;
- Rule : appartenance Source + tenant ;
- Binding : au plus un enabled par `(companyId, sourceId)` ;
- RoutingDecision : idempotence `(companyId, normalizedInboundId, routingConfigurationVersion)` ;
- Index matching : `(companyId, type, normalizedValue)` côté Rules — **justifié** par le matching (§15.3).

### 15.3 PII, indexation et accès

`normalizedValue` **MAY** contenir une donnée métier sensible (email, domaine, keyword).

Par conséquent :

- **MUST NOT** affirmer « aucune PII indexée » de façon absolue ;
- Accès **MUST** être strictement tenanté (`companyId`) ;
- Logs **MUST** être redacted ; **aucune** valeur brute (`value`, `normalizedValue`, subject, body, email) exposée en observabilité ;
- L’index `(companyId, type, normalizedValue)` est **autorisé** car justifié par le matching V1 ;
- Contrôles AuthZ admin + audit des mutations config.

### 15.4 Bornes numériques normatives V1

Reprises de IMPL-PLAN §13.6 — **normatives** pour LOT-2 (configurables serveur, validées) :

| Borne | Défaut normatif |
|-------|-----------------|
| Connections / tenant | 10 |
| Sources / tenant | 200 |
| Rules / Source | 50 |
| Rules actives totales / tenant | 2000 |
| Taille keyword (`normalizedValue` keyword) | 128 caractères |
| Subject stocké | 512 caractères UTF-8 |
| Envelope / payload inline | 256 KiB |
| Taille max `.eml` | 10 MiB |
| Pièces jointes / message | 50 |
| Taille totale artifacts | 50 MiB |
| Batch normalisation/routing | 50 |

Stratégie V1 : cache **tenant-scopé** ; **aucune** lecture globale de toutes les Rules ; invalidation §13.3 ; **pas** de moteur de recherche spécialisé prématuré.

### 15.5 Migrations

Additives uniquement. **MUST NOT** modifier destructivement LOT-1B2.

---

## 16. Observabilité

| Signal | Contenu autorisé |
|--------|------------------|
| route outcomes | counts par `outcome` métier persisté |
| parity outcomes | counts `PARITY_*` + `parityBaselineCode` |
| explained divergence codes | counts codes §14.6 |
| rulesEvaluated | entier |
| cacheHit / cacheMiss | bool/compteurs |
| durationMs | entier |
| companyId / connectionId / sourceIds | opaques |
| idempotentReuse | compteur technique (rejeux) |

**MUST NOT :** subject, body, email, `normalizedValue`, tokens, payloads bruts, stacks provider.

Tous les logs Router / shadow / simulateur **MUST** passer par l’API de redaction Integration (LOT-1C Gate-0 réutilisable).

---

## 17. Flags

Fail-closed. Noms exacts figés en IMPL ; concepts :

| Concept | Défaut | Effet |
|---------|--------|-------|
| Platform foundation | OFF | OFF ⇒ pas de routing Platform |
| Matching / Router enabled | OFF | OFF ⇒ pas de nouvelles décisions |
| Matching tenant allowlist | vide | Routing seulement si `companyId` ∈ allowlist |
| Matching shadow comparison | OFF | OFF ⇒ pas de parity jobs |

**Kill-switch :** couper foundation **ou** matching **MUST** arrêter nouvelles décisions sans toucher legacy.

Flags LOT-1C mail shadow **MUST** rester **indépendants**.

Flags d’admission Draft = **LOT-3 uniquement** — absents / OFF en LOT-2.

---

## 18. Sécurité

1. Redaction obligatoire (subject, body, email, `normalizedValue`, tokens).
2. Secrets / OAuth : hors Router (SECURITY-SPEC).
3. Admin CRUD Sources/Rules/Bindings : AuthZ ADMIN / SUPER_ADMIN ; audit des changements ; pas de secret en clair.
4. Simulateur : tenant-scopé ; pas de persistance durable de payload sensible par défaut (§20.4).
5. Multi-tenant : toute query filtrée `companyId`.
6. Index / PII : §15.3.

---

## 19. Concurrence

1. Deux routages parallèles même `(companyId, normalizedInboundId, routingConfigurationVersion)` → une décision effective (contrainte SQL + idempotence §9.2).
2. Modification config concurrente → nouveau hash ; décisions en vol utilisent le snapshot (et hash) chargé en début d’invocation.
3. Cache tenant **MUST** être invalidé sur mutation config (§13.3).
4. Tests PG `Promise.all` **MUST** couvrir l’insert décision concurrent.

---

## 20. Tests (MUST)

### 20.1 Unitaires

- Normalisation `normalizedValue` (email, domain, keyword).
- Matching : identité seule ; identité + qualificatif ; keyword-only refusé comme admission (pas d’identité).
- `SUBJECT_KEYWORD` avec/without subject.
- `BODY_KEYWORD` : port local avec/without corps ; **aucun** fetch simulé autorisé.
- Ambiguïté → `AMBIGUOUS_SOURCE` sans attribution.
- Binding manquant → `NO_ACTIVE_BINDING`.
- Scope Connection **uniquement** via Binding.
- Hash config : stabilité + sensibilité aux changements fonctionnels.
- Idempotence : rejeu retourne la même décision ; outcome persisté inchangé ; pas de ligne `DUPLICATE` de remplacement.
- Redaction (subject/email/normalizedValue absents des logs).
- Barrière : aucune API Router n’appelle admission/Draft.

### 20.2 PostgreSQL

- CRUD Source/Rule/Binding + contraintes unicité.
- Insert `RoutingDecision` idempotent.
- Isolation multi-tenant.
- Concurrence insert décision.
- Envelope lifecycle **inchangé** (`NORMALIZED`) après routage shadow.

### 20.3 Non-régression

- Aucun Draft supplémentaire en shadow matching.
- Aucun second poll Gmail.
- Stats/status legacy inchangés si Router/shadow échoue.
- Booking non touché.
- LOT-1C chemin Envelope non régressé.
- Aucun CAS `ROUTED` / `NO_MATCH` / `AMBIGUOUS` Envelope.

### 20.4 Simulateur service

- Entrée MESSAGE contrôlée → outcomes ; aucun Draft ; aucun worker ; **aucune UI**.
- **Aucune persistance durable** par défaut (Normalized/Envelope/RoutingDecision/audit payload).
- Toute exception d’audit **MUST** être une décision **explicitement documentée** dans le plan d’implémentation (opt-in, tenant-scopé, sans PII en clair).

---

## 21. Rollback

| Action | Effet |
|--------|-------|
| Matching OFF / foundation OFF | Stop nouvelles décisions ; legacy seul |
| Retirer tenant allowlist | Stop pour ce tenant |
| Décisions déjà persistées | **Conservées** (pas de DELETE massif) |
| Envelope | Inchangées (`NORMALIZED`) — rien à « rollback » lifecycle routage |

Rollback **MUST NOT** exiger migration destructive.

---

## 22. Critères de sortie — MODULE CLOSED

Le lot **MUST NOT** être CLOSED tant que :

1. SPEC R1 + plan d’implémentation GO + implémentation + revue indépendante + validation manuelle utilisateur.
2. Sources / Rules / Bindings persistés et validés.
3. Router produit les outcomes métier correctement ; idempotence §9.2 prouvée.
4. `SUBJECT_KEYWORD` / `BODY_KEYWORD` conformes §11–§12 (D1–D8) ; LOT-2A subject si retenu dans le lot.
5. Hash `routingConfigurationVersion` stable et testé (§13.4).
6. Shadow matching L1 : zéro side-effect ; projection §14.5 ; Envelope reste `NORMALIZED` ; critères §14.8.
7. Barrière LOT-3 prouvée (aucun consommateur d’admission).
8. Simulateur service disponible (§20.4).
9. Flags fail-closed + rollback prouvés.
10. Observabilité §16 sans fuite de valeurs brutes.
11. Tests §20 verts.
12. Aucun LOT-3 (admission Draft) dans le même diff de fermeture.
13. Booking intact ; pas de second poll.

---

## 23. Allowlist d’implémentation (catégories)

| Autorisé | Interdit |
|----------|----------|
| `src/lib/integration/sources/**`, `rules/**`, `bindings/**`, `router/**`, `shadow/**` (matching), `simulator/**` | Review, Conversion, Booking, UI LOT-6 |
| LOT-2A enrichissement subject (mapper/normalizer MESSAGE) | Fetch Gmail supplémentaire |
| Persistence + migrations additives LOT-2 | Migrations destructives 1B2 ; CAS Envelope routage |
| Actions admin technique AuthZ (sans UI complète) | Marketplace connecteurs ; admission Draft |
| Tests integration / PG | Dual-write Draft ; worker content |

Chemins exacts figés en plan d’implémentation du lot.

---

## 24. Hors LOT / LOT-3+

- `PipelineAdmission` + création Draft ;
- Consommation admission des `RoutingDecision` ;
- CAS Envelope `ROUTED` / branches routage ;
- Bascule admission tenant pilote ;
- UI admin / simulateur UI ;
- Fan-out ; DOCUMENT/EVENT ;
- Unification Booking.

---

## Historique

| Version | Date | Statut |
|---------|------|--------|
| 0.1.0 | 2026-08-01 | DRAFT FOR ARCHITECTURAL REVIEW — Discovery B + décisions subject D1–D8 |
| 0.2.0 | 2026-08-01 | **R1** — baseline L1, hash config, lifecycle NORMALIZED, BODY port local, barrière LOT-3, DUPLICATE, scope Binding, PII/index, LOT-2A, renvois corrigés |
