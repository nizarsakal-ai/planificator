# PLAN-INTEGRATION-PLATFORM-001-IMPL-PLAN

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-INTEGRATION-PLATFORM-001-IMPL-PLAN |
| **Version** | **1.1.0 (R1)** |
| **Statut** | **READY FOR ARCHITECTURE REVIEW** |
| **Programme** | PLAN-INTEGRATION-PLATFORM-001 |
| **Fichier canonique** | `docs/integration-platform-001.impl-plan.md` |
| **SPEC de référence** | `docs/integration-platform-001.spec.md` **v1.1.0 (R1)** |
| **Bases** | PLAN-INTEGRATION-PLATFORM-001-AUDIT ; SPEC R1 ; IMPL-PLAN-REVIEW-001 ; architecture Acquisition `main` ; OPS-001→004 ; PLAN-ACQ-005 ; Conversion 005D ; Booking legacy ; ENGINEERING-STANDARD-001 ; PLAN-GOVERNANCE-001 |
| **Date** | 2026-07-23 |
| **Code dans ce lot plan** | **Aucun** |
| **Migration dans ce lot plan** | **Aucune** — migrations conceptuelles décrites lot par lot ; aucune SQL ici |

---

## 0. Objet

Ce document est le **seul plan d’implémentation** autorisé pour la Platform V1.  
Il découpe le travail en **sous-lots séquentiels** (strangler), avec dépendances, allowlists resserrées, contrats, idempotence, flags, validations et critères de fermeture.

**Interdit :** réinterprétation de l’architecture SPEC ; big-bang ; fan-out V1 ; familles `DOCUMENT` / `EVENT` en runtime V1 ; toucher Review/Conversion métier ; brancher Booking ; coder partenaires/domaines en dur ; démarrer du code avant SECURITY-SPEC CLOSED.

---

## 1. Architecture retenue (rappel normatif)

```text
IntegrationConnection → Connector Runtime → InboundEnvelope
  → Family Normalizer (MESSAGE) → NormalizedInbound / NormalizedMessage
  → Tenant Router → PipelineBinding (1 Source → 1 Pipeline)
  → Domain Pipeline consultations (seul créateur de projection métier)
```

Distinctions obligatoires :

| Concept | Rôle |
|---------|------|
| **Provider** | Fournisseur externe (ex. Gmail API) — confiné aux adapters |
| **ConnectorType** | Type de runtime enregistré (ex. mail poll, upload) |
| **IntegrationConnection** | Instance tenant-scopée d’un ConnectorType |
| **InboundSource** | Source métier configurable (identité + qualificatifs) |
| **Pipeline** | Autorité de projection métier (`consultations` en V1) |

- V1 runtime = famille **MESSAGE** uniquement.  
- Preuve M5 = upload **`.eml`** (mode **UPLOAD**), **pas** un second Connector Runtime mail (M5bis hors V1).  
- Shadow = observe-only ; Legacy = autorité métier jusqu’à bascule.  
- SECURITY-SPEC **CLOSED** avant **tout** lot de code Platform.

---

## 2. Gouvernance et séparation des programmes

### 2.1 Gates documentaires et branches

| Gate | Condition | Bloque |
|------|-----------|--------|
| **G0** | SPEC v1.1.0 R1 déposée + SPEC-REVIEW favorable | Tout IMPL |
| **G1** | SECURITY-SPEC créée, auditée, corrigée, validée, **fusionnée sur `main`**, déclarée **SECURITY SPEC CLOSED** | **Tout lot Platform de code** (dès LOT-1A) |
| **G2** | IMPL-PLAN (ce document) revue architecture favorable + docs Platform sur **branche dédiée**, mergeables hors ACQ-005 | LOT-0+ exécutable |
| **G3** | Parité / critères de sortie du lot N atteints | Lot N+1 |
| **G4** | Working tree **propre** ; lot précédent **fusionné sur `main`** | Démarrage de chaque lot |

Règles normatives :

1. Aucun lot Platform ne commence avant validation et merge des documents Platform sur une **branche dédiée**.  
2. Les documents Platform **ne doivent jamais** être inclus dans une PR ACQ-005.  
3. Toute implémentation Platform exige une **branche propre** créée depuis le `main` alors courant.  
4. Working tree propre obligatoire avant démarrage de chaque lot.

### 2.2 Interaction ACQ-005

**`ACQ-005_CAN_CONTINUE`** — sous réserve de commits, PR et revues **totalement séparés**.  
La Platform ne bloque pas la finalisation du Review Workflow tant qu’aucun fichier Platform partagé n’est modifié dans le lot Review.

---

## 3. Inventaire dépôt — réutiliser / wrapper / remplacer / hors scope

### 3.1 Réutiliser tel quel

| Élément | Paths principaux |
|---------|------------------|
| Persistance ACQ messages/drafts/PJ/content | `prisma/schema.prisma` (Acquisition*, WorksiteImportDraft) |
| Review / Conversion métier | `src/lib/acquisition/review/**`, `conversion/**`, actions associées, UI consultations |
| Extraction + cron | `src/lib/acquisition/extraction/**`, cron `acquisition-extraction` |
| Attachment recovery (déjà agnostique) | `attachments/attachment-recovery-orchestrator.ts` |
| Matrice flags pipeline ACQ | `acquisition-flag-matrix.ts` + flags review/conversion/extraction/content/download |
| Patterns cron `CRON_SECRET` | routes `src/app/api/cron/acquisition-*` |
| Tests de non-régression | `tests/acquisition/import-draft-review*`, `conversion*`, `eligibility*` |

### 3.2 Wrapper (adaptateurs strangler)

| Élément | Paths | Rôle cible |
|---------|-------|------------|
| Sync Gmail | `connector/acquisition-gmail-sync.*`, `gmail-mail-provider.adapter.ts` | Connector Runtime mail (LOT-1C) |
| Mapper / MIME / sanitizer | `gmail-message.mapper.ts`, `gmail-mime-parser.ts`, `gmail-message-sanitizer.ts` | Normalizer MESSAGE (sans admission) |
| Ingestion | `acquisition.service.ts` `registerIncomingMessage`, ports ingestion | Pont temporaire → Router/Pipeline (autorité retirée LOT-3) |
| Content/Attachment sources Gmail | `gmail-message-content-source.adapter.ts`, `gmail-attachment-source.adapter.ts` | Derrière capability / Artifact Provider (LOT-4) |
| OAuth + listing | `GmailConnection`, `gmail-connection.client.ts`, `gmail-connection-listing.adapter.ts` | Lecture via façade ; **pas** d’autorité secret Platform (voir §12) |
| Cursor | `AcquisitionScanCursor` | Watermark Connection (jusqu’à bascule watermark) |

### 3.3 Remplacer comme autorité (cible)

| Élément | Remplacement | Lot |
|---------|--------------|-----|
| `ELIGIBLE_SENDER_DOMAIN` / `isEligibleSenderDomain` | InboundSource + Rules (données) | LOT-2 seed ; LOT-3 hors chemin chaud |
| Admission dans `registerIncomingMessage` | Tenant Router + Pipeline consultations | LOT-3 |
| Défauts Provider hardcodés workers | `connectionId → capability → Artifact Provider` | LOT-4 |
| Confusion `AcquisitionSource` = source métier | Canal technique ; métier = InboundSource | LOT-2 |

### 3.4 Hors scope V1 (ne pas modifier)

| Élément | Paths |
|---------|-------|
| Booking | `src/app/api/cron/gmail-scan/**`, `src/lib/booking/**`, `PendingAccommodation` |
| Review dirty/flags métier 005 | hors changements fonctionnels |
| Conversion 005D métier | hors changements fonctionnels |
| Marketplace ConnectorTypes | exclu SPEC |
| Familles DOCUMENT / EVENT | Annexe A SPEC — hors programme V1 |
| Fan-out multi-pipelines | hors V1 |
| Unification Booking / Platform | exige SPEC Booking/Identity dédiée |

---

## 4. Découpage final des lots

Ordre **strict**. Un lot ne démarre que si le précédent est **CLOSED** et les critères §25 satisfaits.  
**LOT-6 n’est pas parallélisable librement** : obligatoire après LOT-3 et **avant** tout tenant pilote réel hors configuration contrôlée de staging.

| Lot | Alignement SPEC | Objectif | Parité / sortie |
|-----|-----------------|----------|-----------------|
| **LOT-0** | M0 | Gouvernance, SECURITY-SPEC, gates, conventions | SECURITY SPEC CLOSED + docs |
| **LOT-1A** | M1 contrats | Types, registry, capabilities, contrats — **sans** migration ni runtime | Contrats + architecture tests |
| **LOT-1B** | M1 persist | Connection + Envelope (migrations additives séparées) | Persistance Foundation |
| **LOT-1C** | M1 bridge | Bridge mail existant → Envelope/Normalized **shadow** ; un seul poll | **Parité Runtime** |
| **LOT-2** | M2 | Sources/Rules/Binding/Router + Shadow comparison + simulateur service + métriques | **Parité Matching** |
| **LOT-3** | M3 | PipelineAdmission + bascule admission ; anti dual-write | **Parité Drafts** |
| **LOT-4** | M4 | Workers via connectionId + façade InboundArtifact | **Parité Workers** |
| **LOT-5** | M5 | Upload `.eml` UPLOAD MESSAGE | **Preuve extensibilité** |
| **LOT-6** | Admin | Admin tenant complète + UI simulateur | Ops admin avant généralisation |
| **LOT-7** | Hardening | Quotas, alertes, runbooks, décommission, retrait flags | Fermeture programme IMPL V1 |

**M5bis** (2ᵉ Connector Runtime mail) : **hors plan V1**.

```text
LOT-0 (SECURITY CLOSED)
  → LOT-1A (contrats)
  → LOT-1B (persistance)
  → LOT-1C (bridge shadow)
  → LOT-2 (matching + shadow + simulateur service)
  → LOT-3 (pipeline admission)
  → LOT-4 (workers)
  → LOT-5 (upload .eml)
  → LOT-6 (admin UI complète)   [obligatoire avant généralisation ; après LOT-3]
  → LOT-7 (hardening / décommission)
```

---

## 5. LOT-0 — Gouvernance et Security

### 5.1 Contenu (documentation uniquement)

- Créer `docs/integration-platform-001-security.spec.md`.  
- Faire auditer indépendamment, corriger, valider, **merger sur `main`**, déclarer **SECURITY SPEC CLOSED**.  
- Figer règles de branches Platform vs ACQ-005.  
- Figer conventions de version / noms de flags conceptuels.  
- Confirmer allowlists LOT-1A…7 (à finaliser chemin par chemin avant chaque IMPL).

> **Aucun lot Platform de code ne commence tant que la SECURITY-SPEC n’est pas CLOSED.**

Les secrets, tokens, OAuth, références de credentials, clés maîtres et rotations restent **entièrement** gouvernés par cette SPEC dédiée — y compris si LOT-1A ne stocke encore aucun secret.

### 5.2 Allowlist

| Action | Paths |
|--------|-------|
| Créer | `docs/integration-platform-001-security.spec.md` |
| Créer/MAJ | ce IMPL-PLAN si amendements de revue ; docs gates Platform |
| Interdit | tout `src/**`, `prisma/**`, `tests/**`, Booking, Review, Conversion |

### 5.3 Fermeture

**CLOSED** quand G0+G1+G2 satisfaits et SECURITY SPEC CLOSED sur `main`.

---

## 6. LOT-1A — Contrats Platform minimaux

### 6.1 Objectif

Introduire types et contrats **sans migration** et **sans changement runtime**.

Contenu :

- Connector Registry minimal (§20)  
- Capabilities minimales (§20)  
- Contrats Connection, Envelope, NormalizedMessage, PipelineAdmission (§7.2–7.3, §9, §16.2–16.3)  
- Pipeline Registry map typée (§21)  
- Tests d’architecture permanents (amorçage)

### 6.2 Allowlist (catégories — chemins exacts figés en revue de lot IMPL)

| Catégorie | Autorisé |
|-----------|----------|
| Créations | `src/lib/integration/contracts/**`, `src/lib/integration/registry/**`, `src/lib/integration/types/**` |
| Modifications | **Aucune** sur Acquisition runtime |
| Tests | `tests/integration/architecture/**`, `tests/integration/contracts/**` |
| Docs | notes de lot si besoin |
| Migrations | **Aucune** |
| Interdits | `src/lib/acquisition/**` (sauf lecture pour greps de tests d’archi), `prisma/**`, Booking, Review, Conversion, workers, UI |

### 6.3 Fermeture

Contrats compilables + architecture tests verts + allowlist respectée.

---

## 7. LOT-1B — Persistance Foundation

### 7.1 Objectif

Migrations **additives** uniquement :

- `IntegrationConnection` (sous-migration **LOT-1B1**)  
- `InboundEnvelope` + métadonnées normalisées techniques (sous-migration **LOT-1B2**)  
- lifecycle, idempotence, FK composites tenant  

**Aucun** bridge fournisseur ; **aucun** draft ; **aucune** modification Booking.

### 7.2 Connection — exigences

- Migration Connection **séparée** de Envelope.  
- Additives ; **aucun DROP**.  
- `companyId` obligatoire.  
- FK composites tenant.  
- Uniques tenant-scopés.  
- `config` JSON **non secret**.  
- Watermark opaque.  
- Lifecycle : `active` / `disabled` / `error` / `pending-auth` / `archived`.  
- Suppression physique interdite tant que références historiques existent.  
- Health **séparé** de la configuration.  
- `secretRef` gouverné exclusivement par SECURITY-SPEC.

### 7.3 InboundEnvelope — états et transitions

États exacts :

`RECEIVED` · `NORMALIZED` · `NORMALIZE_FAILED` · `ROUTED` · `NO_MATCH` · `AMBIGUOUS` · `DISPATCHED` · `DISCARDED` · `ARCHIVED`

| Transition | Nature |
|------------|--------|
| `RECEIVED` → `NORMALIZED` / `NORMALIZE_FAILED` | Retryable si `NORMALIZE_FAILED` (replay explicite) |
| `NORMALIZED` → `ROUTED` / `NO_MATCH` / `AMBIGUOUS` | Routage |
| `ROUTED` → `DISPATCHED` | Après admission pipeline (LOT-3+) |
| `*` → `DISCARDED` / `ARCHIVED` | **Terminales** (sauf politique audit documentée) |
| `NORMALIZE_FAILED` / erreurs | Retryable **uniquement** via replay explicite |

Règles :

- Replay **explicite** uniquement ; audit des replays.  
- `schemaVersion` porté.  
- `payloadRef` opaque.  
- Rétention : pas de suppression de l’historique métier.  
- **Aucune** transition du domaine Consultations dans Envelope.

### 7.4 Allowlist

| Catégorie | Autorisé |
|-----------|----------|
| Créations | repositories Foundation sous `src/lib/integration/persistence/**` (ou équivalent figé) |
| Modifications | `prisma/schema.prisma` + migrations Platform **1B1** puis **1B2** uniquement |
| Tests | PG : FK composites, uniques tenant, cross-tenant refusés |
| Interdits | Bridge Gmail, Booking, Draft, Review, Conversion, workers runtime |

### 7.5 Fermeture

Migrations appliquées sur DB test fraîche + schéma existant ; contraintes vérifiées ; aucun effet métier.

---

## 8. LOT-1C — Bridge mail existant en shadow

### 8.1 Objectif

- **Un seul** poll distant (réutiliser le résultat legacy).  
- Projection du résultat existant → Envelope → NormalizedMessage.  
- Legacy reste **seule** autorité métier.  
- Shadow : aucune mutation métier.  
- Booking inchangé.

### 8.2 Observabilité minimale (progressive)

- runtime received / duplicate  
- normalize success / failure  
- durée  

### 8.3 Allowlist

| Catégorie | Autorisé |
|-----------|----------|
| Modifications | Ports/adapters Acquisition **strictement nécessaires** au bridge (ex. câblage fin `acquisition-gmail-sync.service.ts`, listing adapter) |
| Créations | adapters bridge sous `src/lib/integration/connectors/mail-bridge/**` (chemin exact figé en revue lot) |
| Flags | Platform foundation + shadow (tenant allowlist) |
| Tests | Sync parity ; envelope lifecycle ; **zéro Draft extra** ; non-régression sync/eligibility |
| Interdits | Booking / `gmail-scan` ; Review ; Conversion ; workers download/content défauts ; création Draft Platform |

### 8.4 Fermeture — Parité Runtime

Même volume ingested/rejected vs baseline ; idempotence runtime préservée ; aucun Draft supplémentaire ; un seul poll distant ; Booking intact.

---

## 9. Contrat PipelineAdmission (normatif)

Champs minimums :

| Champ | Rôle |
|-------|------|
| `companyId` | Isolation tenant |
| `normalizedInboundId` | Lien NormalizedInbound |
| `routingDecisionId` | Décision Router traçable |
| `sourceId` | InboundSource matchée |
| `pipelineId` | Toujours `consultations` en V1 |
| `schemaVersion` | Version contrat |
| `artifactRefs` | Façade InboundArtifact |
| `pipelineIdempotencyKey` | Idempotence aval |
| `occurredAt` | Instant événement source |
| `admittedAt` | Instant admission |
| Réf. NormalizedMessage / projection sûre | Données nécessaires au pipeline **sans** types fournisseur |

Règles :

- Router produit une **décision** ; il ne crée **aucun** draft.  
- Dispatcher transmet le contrat.  
- **Pipeline Consultations** = seule autorité de projection métier.  
- Connector, Normalizer et Router ne créent **jamais** `AcquisitionMessage` ni `WorksiteImportDraft`.  
- Review et Conversion restent inchangés.  
- **Aucun** `connectorType` dans le contrat consommé par le métier.

---

## 10. Matrice d’idempotence à sept niveaux

| Niveau | Entité | Clé | Comportement |
|--------|--------|-----|--------------|
| **1** | Runtime / réception externe | `companyId + connectionId + externalId` | Fallback contrôlé si `externalId` absent : hash canonique **versionné** défini par le Connector Runtime |
| **2** | InboundEnvelope | Clé runtime | Une envelope effective ; double poll/webhook/upload → retourne l’existant ; pas de seconde normalisation concurrente non contrôlée |
| **3** | NormalizedInbound | `envelopeId + normalizerFamily + schemaVersion` | Nouvelle `schemaVersion` → nouvelle version logique, **pas** nouvel inbound métier silencieux |
| **4** | RoutingDecision | `normalizedInboundId + routingConfigurationVersion` | Replay explicite → décision traçable **sans** effacer l’historique |
| **5** | PipelineAdmission | `companyId + pipelineId + normalizedInboundId` | V1 : un seul binding actif Source→pipeline |
| **6** | AcquisitionMessage | Lien stable vers Admission ou NormalizedInbound | Aucune seconde ligne métier pour la même admission key ; unicité historique adaptée **sans** dépendance fournisseur |
| **7** | WorksiteImportDraft | Une projection draft / admission consultation | Contrainte ou **transaction atomique** obligatoire |

---

## 11. Scénarios anti-double obligatoires

| # | Scénario | Résultat attendu |
|---|----------|------------------|
| 1 | Poll legacy + shadow | **Un** Draft legacy ; shadow observe seulement |
| 2 | Double invocation du même poll | Envelope existante ; pas de second Draft |
| 3 | Cutover legacy → new path | Un seul chemin d’autorité ; pas de second Draft |
| 4 | Replay du même Envelope | Admission/Draft existants résolus ; pas de double |
| 5 | Renormalisation nouvelle `schemaVersion` | Nouvelle version logique ; pas de second Draft silencieux |
| 6 | Changement de Rules | Nouvelles décisions traçables ; pas de double Draft sur inbound déjà admis |
| 7 | Upload `.eml` identique ×2 | Idempotence hash/runtime ; un seul Draft |
| 8 | Même message sur **deux Connections** du même tenant | **Pas** de fusion silencieuse sur le seul contenu ; décision explicite via clé de corrélation **sûre** ; si équivalence non démontrable → cas distinct ou résolution contrôlée ; **jamais** déduplication cross-connection fragile |
| 9 | Deux workers concurrents | Contraintes persistées / TX ; un seul gagnant |
| 10 | Rollback vers legacy après tentative new path | Pas de second Draft ; autorité unique restaurée |

Règle absolue :

> Aucun scénario ne peut créer deux `AcquisitionMessage` ou deux `WorksiteImportDraft` pour la même admission métier.

### 11.1 Transaction de création métier (LOT-3)

La création ou résolution de `PipelineAdmission` + `AcquisitionMessage` + `WorksiteImportDraft` doit être **atomique** ou rendue idempotente par **contraintes persistées** et gestion explicite des conflits.

**Interdits :** check-then-create non atomique ; double-write legacy/new ; déduplication uniquement en mémoire ; rattrapage par DELETE.

---

## 12. Booking et GmailConnection

### 12.1 Constat

`GmailConnection` est actuellement partagée par Acquisition, OAuth, content/attachments et Booking legacy (`gmail-scan`, etc.).

### 12.2 Décision strangler (LOT-1 → LOT-5)

- Ne pas migrer ni déplacer les tokens Booking.  
- Ne pas modifier `gmail-scan`.  
- Ne pas modifier les modèles Booking.  
- Ne pas changer les crons Booking.  
- Ne pas supprimer `GmailConnection`.  
- Ne pas renommer ses colonnes.  
- Ne pas changer son cycle OAuth.

### 12.3 Stratégie

- `IntegrationConnection` peut **référencer ou projeter** temporairement une connexion existante **sans** en devenir l’autorité de secret.  
- Le bridge Acquisition lit la connexion existante via une **façade contrôlée**.  
- Aucune double copie durable de token.  
- Aucune rotation Platform ne doit casser Booking.  
- Toute migration définitive de `GmailConnection` exige une **SPEC Booking/Identity** dédiée.

**Verdict plan :** `BOOKING_ISOLATION_SAFE_BY_ENCAPSULATION`

---

## 13. LOT-2 — Sources, Rules, Binding, Router et Shadow comparison

### 13.1 Objectif

- Configuration tenant (Sources / Rules / Bindings).  
- Matching identité ∧ qualificatifs.  
- Décisions de routing.  
- Comparaison legacy.  
- **Simulateur minimal** (service technique).  
- Métriques shadow.

### 13.2 Matching — règles opérationnelles

Une Source **active** ⇒ ≥1 identité active : `SENDER_EMAIL` ou `SENDER_DOMAIN`.

Qualificatifs V1 : `RECIPIENT_EMAIL`, `SUBJECT_KEYWORD`, `BODY_KEYWORD` **seulement** si body déjà disponible **sans** fetch caché supplémentaire.

Normalisation serveur : trim ; lowercase ; Unicode normalisé ; email validé ; domaine **exact** ; suppression contrôlée d’un `@` saisi ; **faux suffixes refusés** ; **sous-domaines non matchés par défaut**.

**Interdits :** keyword-only ; regex libre ; expressions exécutables ; scan de règles cross-tenant ; fallback partenaire ; **OR intra-source** d’identités (conforme SPEC : identité ∧ qualificatifs).

Binding V1 : **1 Source → 1 Pipeline** `consultations` — **pas de fan-out**.

Outcomes Router : `MATCH`, `NO_MATCH`, `AMBIGUOUS_SOURCE`, `DUPLICATE`, `NO_ACTIVE_BINDING`, `ERROR`.

### 13.3 Shadow mode (renforcé)

Le flux shadow **réutilise le résultat du même poll distant** que le legacy.

**Interdictions :** second listing distant ; second fetch corps ; second téléchargement PJ ; création de draft ; déclenchement content/attachments/extraction ; mutation statuts métier ; revalidation UI.

**Autorisé uniquement :** créer/résoudre Envelope technique ; normaliser ; router ; persister décision shadow ; métriques de comparaison.

Comparaison legacy ↔ Router :

- même `companyId`  
- même `externalId` / envelope  
- admission vs rejet  
- source logique  
- `reasonCode` stable  
- **aucune** donnée sensible dans les logs  

Outcomes parité :

`PARITY_MATCH` · `PARITY_LEGACY_ONLY` · `PARITY_ROUTER_ONLY` · `PARITY_REASON_DIFFERENCE` · `PARITY_ERROR`

### 13.4 Critères de sortie Shadow (avant LOT-3 / cutover)

- Nombre minimal de cycles/ticks **ou** durée d’observation **définis dans le lot IMPL**.  
- Zéro cross-tenant.  
- Zéro mutation shadow.  
- Zéro double fetch.  
- Zéro double draft.  
- Seuil divergences **non expliquées** = 0.  
- Divergences expliquées documentées.  
- Rollback testé.  
- Métriques disponibles.  
- Validation indépendante + validation manuelle utilisateur.

### 13.5 Simulateur de routage (service LOT-2 ; UI LOT-6)

Obligatoire avant généralisation du tenant pilote.

- Utilise le vrai Normalizer/Router (ou contrats réels).  
- Tenant-scopé ; ADMIN / SUPER_ADMIN.  
- Accepte un exemple MESSAGE contrôlé.  
- Retourne match / no-match / ambiguity ; IDs/règles matchées de façon sûre.  
- Aucun Envelope métier durable sauf audit minimal **explicitement** défini.  
- Aucun draft ; aucun worker.  
- Aucun body/subject sensible conservé par défaut.

### 13.6 Bornes de performance V1 (recommandations initiales)

Valeurs **configurables**, validées serveur ; à confirmer dans le lot IMPL LOT-2 / LOT-5 :

| Borne | Défaut recommandé (à confirmer) |
|-------|----------------------------------|
| Connections / tenant | 10 |
| Sources / tenant | 200 |
| Rules / Source | 50 |
| Rules actives totales / tenant | 2000 |
| Taille keyword | 128 chars |
| Envelope / payload inline | 256 KiB |
| Taille max `.eml` | 10 MiB |
| Pièces jointes / message | 50 |
| Taille totale artifacts | 50 MiB |
| Batch normalisation/routing | 50 |
| Rétention technique payloads | définie en SECURITY/Ops (pas ici) |

Stratégie V1 : cache **tenant-scopé** ; **aucune** lecture globale de toutes les Rules ; invalidation à modification Source/Rule/Binding ; index `(companyId, type, normalizedValue)` ; **pas** de moteur de recherche spécialisé prématuré.

### 13.7 Observabilité LOT-2

- route match / no-match / ambiguous  
- shadow parity (outcomes §13.3)  
- nombre de règles évaluées  
- cache hit / miss  

### 13.8 Allowlist

| Catégorie | Autorisé |
|-----------|----------|
| Créations | `src/lib/integration/sources/**`, `rules/**`, `bindings/**`, `router/**`, `shadow/**`, `simulator/**` (chemins exacts figés) |
| Prisma | LOT-2A Source/Rule ; LOT-2B Binding/RoutingDecision |
| Admin technique | actions lecture/écriture Sources/Rules/Bindings (AuthZ) — UI complète = LOT-6 |
| Tests | matching ; isolation A/B ; shadow no side-effect ; simulateur ; perf bornes |
| Interdits | Review ; Conversion ; workers ; Booking ; modification logique Draft (sauf hooks shadow lecture) |

### 13.9 Fermeture

**CLOSED** = Parité Matching + shadow sans side-effect + critères §13.4 + simulateur service disponible.

---

## 14. LOT-3 — Pipeline Consultations et bascule d’admission

### 14.1 Objectif

- Contrat `PipelineAdmission` (§9).  
- Idempotence aval (§10 niveaux 5–7).  
- Création du draft **uniquement** par le pipeline.  
- Bascule **tenant pilote** (allowlist).  
- Legacy / new path **mutuellement exclusifs** (§15).

### 14.2 Observabilité LOT-3

- pipeline admission  
- duplicate admission blocked  
- draft created / existing  
- legacy / new authority state  

### 14.3 Allowlist

| Catégorie | Autorisé |
|-----------|----------|
| Créations | `src/lib/integration/pipelines/consultations/**`, persistence `PipelineAdmission` si nécessaire |
| Modifications | Point d’admission Acquisition (`acquisition.service.ts` / ports ingestion) — **réduction d’autorité** ; flags strangler |
| Prisma | LOT-3 liens Admission / projection si démontrés |
| Tests | scénarios §11 ; dual-receive ; replay ; review/conversion non-régression |
| Interdits | Changer approve/reject/convert ; Booking ; UI dirty Review ; double-write |

### 14.4 Fermeture — Parité Drafts

Cardinalité Drafts = baseline ; zéro double Draft ; hardcode partenaire hors chemin chaud ; Review/Conversion verts ; Booking inchangé.

---

## 15. Matrice des flags strangler

Flags **conceptuels** (noms env exacts figés en SECURITY-SPEC / revue lot ; concept `PLATFORM_MASTER` = Platform OFF).

| Flag conceptuel | Propriétaire | Portée | Défaut | Invariant | Ordre d’activation | Rollback | Tests | Condition de retrait | Lot suppression |
|-----------------|--------------|--------|--------|-----------|--------------------|----------|-------|----------------------|-----------------|
| **Platform foundation** | Platform lead | Technique | OFF | OFF ⇒ Shadow / New / Upload interdits | 1 (après LOT-1A/B prêts) | OFF immédiat | foundation gated | Après décommission adaptateurs | LOT-7 |
| **Shadow** | Platform lead | Observe | OFF | ON ⇒ **aucune** mutation métier | 2 (LOT-1C/2) | OFF | shadow no Draft / no double fetch | Après parité + cutover stable | LOT-7 |
| **Tenant pilot allowlist** | Platform lead | Tenant IDs | vide | Jamais nom d’entreprise comme clé | Avant Shadow/New sur prod | retirer tenant | allowlist isolation | Après généralisation validée | LOT-7 |
| **New pipeline admission** | Platform lead | Tenant | OFF | Pour un tenant ON ⇒ Legacy **OFF** pour ce tenant | 3 (après §13.4) | OFF + Legacy ON | single authority | Après observation post-cutover | LOT-7 |
| **Legacy admission** | Platform lead | Tenant/global contrôlé | ON | Ne coupe qu’après parité/readiness | Toujours avant New | ON | legacy path | Après New stable + observation | LOT-7 |
| **Upload EML** | Platform lead | Feature | OFF | OFF n’affecte pas autres Connections | Après LOT-5 + AuthZ | OFF | upload idempotence | Après Upload stabilisé ou fusion foundation | LOT-7 |
| **Platform OFF** (`PLATFORM_MASTER`) | Ops/Platform | Global | OFF jusqu’à readiness | OFF empêche **nouvelles** admissions Platform ; **ne** supprime **aucune** donnée ; **ne** coupe **pas** traitements métier déjà engagés | Kill switch | OFF | kill-switch | Conservé durablement ou retiré après PRR | Post-PRR |

### 15.1 Invariants obligatoires (rappel)

1. Foundation OFF ⇒ Shadow / New admission / Upload interdits.  
2. Shadow ON ⇒ aucune mutation métier.  
3. New admission ON pour un tenant ⇒ Legacy admission OFF pour ce même tenant.  
4. Legacy ne peut être coupée qu’après parité et readiness prouvées.  
5. New et Legacy ne sont **jamais** simultanément autorités.  
6. Activation globale interdite sans allowlist pilote validée.  
7. Upload OFF n’affecte pas les autres Connections.  
8. Platform OFF : pas de nouvelles admissions Platform ; données et traitements engagés préservés.

Flags ACQ existants (review, conversion, extraction, content, download, gmail cron) : **conservés**.

---

## 16. LOT-4 — Workers et façade InboundArtifact

### 16.1 Objectif

- Content + attachments via `connectionId` → capability → Artifact Provider.  
- Suppression des dépendances fournisseur du **domaine**.  
- Aucun changement métier extraction / Review / Conversion.

### 16.2 InboundArtifact — façade

- Façade générique.  
- Mapping vers attachments Acquisition existants.  
- **Pas** de duplication des binaires.  
- Stockage réel conservé temporairement.  
- IDs stables ; hash ; mimeType ; size ; availability ; `fetchRef` opaque.  
- Provider résolu par `connectionId` / capability.

Critère LOT-4 : content et attachments **n’importent plus** de types fournisseur dans couches domaine/application ; extraction 005B, Review et Conversion **fonctionnellement** inchangées.

### 16.3 NormalizedMessage — refs workers (contrat)

Champs conceptuels : `companyId`, `connectionId`, `envelopeId`, `normalizedInboundId`, `schemaVersion`, `externalMessageRef` opaque, `bodyRef` / `bodyFetchRef`, `artifactRefs`, `from`, `to`, `subject`, `receivedAt`, `normalizedHash`, capacités via registry.

Règle : refs opaques **jamais** interprétées par le domaine ; seul l’adapter résolu par `connectionId` les comprend ; **aucun** type SDK fournisseur dans le contrat pipeline.

### 16.4 Observabilité LOT-4

- content / artifact resolution  
- capability unavailable  
- provider mapping failure  

### 16.5 Allowlist

| Catégorie | Autorisé |
|-----------|----------|
| Modifications | `content/message-content.service.ts`, ports ; `attachment-download.service.ts` ; adapters Gmail **wrap** uniquement |
| Créations | façade `src/lib/integration/artifacts/**`, capability resolver |
| Prisma | LOT-4 adaptations artifacts **uniquement si démontrées** |
| Tests | parity content/download ; architecture no Provider in core |
| Interdits | Review ; Conversion ; Booking ; extraction métier ; politiques retry hors nécessité |

### 16.6 Fermeture — Parité Workers

---

## 17. LOT-5 — Upload `.eml` (preuve M5)

### 17.1 Objectif

- Mode **UPLOAD** ; famille **MESSAGE** uniquement.  
- Même Normalizer, Router et Pipeline.  
- Preuve d’extensibilité : **aucun** changement Router / Pipeline consultations / Review / Conversion.

### 17.2 Exigences

- ADMIN / SUPER_ADMIN tenant-scopé.  
- Parsing sûr ; limites taille / MIME ; hash / idempotence.  
- Simulateur ≠ ingestion.  
- **Pas** de système DOCUMENT générique.

### 17.3 Observabilité LOT-5

- upload accepted / rejected / duplicate  

### 17.4 Allowlist

| Catégorie | Autorisé |
|-----------|----------|
| Créations | `src/lib/integration/connectors/upload-eml/**` ; action/UI admin upload minimale |
| Tests | parsing ; taille ; idempotence ; isolation ; E2E → MATCH/NO_MATCH → Draft si rules |
| Interdits | Modifier Router matching core ; Review ; Conversion ; Booking ; DOCUMENT générique |

### 17.5 Fermeture

Preuve : grep/diff zéro changement Review/Conversion/Router/Pipeline core.

---

## 18. Administration et ordre produit (LOT-6)

### 18.1 Ordre produit

| Étape | Minimum |
|-------|---------|
| **Avant shadow staging** | Fixtures / scripts de test **autorisés** |
| **Avant tenant pilote réel** | Service/actions admin Sources/Rules/Bindings ; AuthZ ; simulation ; audit des changements |
| **Avant généralisation** | UI ADMIN complète : Connections, Sources, Rules, Bindings, santé, simulateur |

Aucun script manuel ne reste la solution produit définitive.  
**LOT-6 obligatoire après LOT-3 et avant généralisation.**  
LOT-6 doit être **terminé avant tout tenant pilote réel hors configuration contrôlée de staging**.

### 18.2 Contenu LOT-6

Connections (créer/modifier/reconnecter/désactiver/réactiver), Sources, Rules, Bindings, santé, simulateur UI, audit admin — journalisés ; pas de secret en clair UI ; AuthZ Page→Action→Service.

### 18.3 Allowlist

`src/lib/integration/admin/**`, actions Platform, pages Paramètres / « Sources » ; tests AuthZ ; **interdit** logique matching dans UI ; Booking ; Review dirty.

---

## 19. LOT-7 — Hardening et décommission

### 19.1 Contenu

Performance, quotas, rétention, alertes, runbooks, stress, décommission legacy, retrait des flags temporaires.  
Dashboards / alertes / runbooks **avancés** (obs progressive déjà en LOT-1C…5).

### 19.2 Décommission legacy

Pour chaque composant : owner ; lot de retrait ; prérequis ; métriques ; durée d’observation ; tests rollback ; vérification Booking ; validation indépendante ; validation utilisateur.

| Composant | Lot retrait (cible) | Prérequis |
|-----------|---------------------|-----------|
| Constante d’éligibilité historique | LOT-7 (hors chemin chaud dès LOT-3) | Parité Matching + Drafts |
| Mapper direct fournisseur→Acquisition | LOT-7 | Parité Runtime + workers |
| Autorité `registerIncomingMessage` | LOT-7 | New admission stable + observation |
| Défauts adapters content/attachments | LOT-7 | Parité Workers LOT-4 |
| Flags strangler | LOT-7 / post-PRR | Observation + rollback testé |
| Types fournisseur dans le domaine | LOT-7 | Grep architecture verts |
| Modèles legacy | Seulement si plus référencés | Booking vérifié non impacté |

**Aucun retrait dans LOT-1 à LOT-4** sans preuve de parité complète.  
Critères objectifs : parité mesurée ; durée d’observation ; zéro divergence critique ; rollback testé ; aucune dépendance Booking ; migration historique validée.

---

## 20. Connector Registry, capabilities et SDK minimal

### 20.1 Registry V1

Map/factory interne :

`connectorType → runtime factory → MESSAGE normalizer → capabilities`

### 20.2 Capabilities V1 (uniquement besoins réels P1–P5)

`POLL` · `UPLOAD` · `CONTENT_FETCH` · `ARTIFACT_FETCH` · `DELTA_CURSOR` · `REPLAY_FROM_ENVELOPE`

Pas de capacités hypothétiques sans usage.

### 20.3 Connector SDK V1

Seulement : contrats ; erreurs génériques ; contexte tenant/connection ; helpers idempotence ; observabilité commune ; lifecycle run.

**Interdit :** auth / pagination / protocole universels. Logique spécifique = adapter.

---

## 21. Pipeline Registry minimal

Décision V1 :

- Map typée interne.  
- Un seul pipeline : `consultations`.  
- Contrat unique `admit(PipelineAdmission)`.  
- **Aucun** SDK Pipeline générique.  
- **Aucune** méthode abstraite `accept/process/reject` prématurée.  
- Aucune chaîne libre dispersée.

Un vrai Pipeline SDK est différé jusqu’à un **deuxième** pipeline concret.

---

## 22. Migrations conceptuelles par sous-lot

| Sous-lot | Contenu |
|----------|---------|
| **LOT-1B1** | IntegrationConnection |
| **LOT-1B2** | InboundEnvelope / Normalized metadata |
| **LOT-2A** | InboundSource / Rule |
| **LOT-2B** | Binding / RoutingDecision |
| **LOT-3** | PipelineAdmission / liens projection métier **si nécessaires** |
| **LOT-4** | Adaptations artifacts **uniquement si démontrées** |

Toutes : additives ; **aucun DROP** ; aucun backfill par nom d’entreprise ; aucune donnée partenaire codée ; FK composites tenant ; uniques tenant-scopés ; testées sur DB fraîche **et** schéma existant ; rollback **runtime par flags**, pas par suppression de colonnes.

---

## 23. Observabilité progressive

| Lot | Métriques minimales |
|-----|---------------------|
| LOT-1C | received/duplicate ; normalize ok/fail ; durée |
| LOT-2 | route outcomes ; shadow parity ; règles évaluées ; cache hit/miss |
| LOT-3 | admission ; duplicate blocked ; draft created/existing ; authority state |
| LOT-4 | content/artifact resolution ; capability unavailable ; mapping failure |
| LOT-5 | upload accepted/rejected/duplicate |
| LOT-7 | dashboards, alertes, runbooks avancés |

---

## 24. Critères de passage entre lots

Chaque transition LOT-N → LOT-N+1 exige **tous** les points suivants :

1. Lot précédent **fusionné sur `main`**.  
2. Working tree **propre**.  
3. Migration appliquée sur DB test fraîche si applicable.  
4. Tests unitaires verts.  
5. Tests PostgreSQL verts.  
6. Tests concurrence/stress verts si applicables.  
7. Architecture tests verts.  
8. Observabilité vérifiée.  
9. Rollback testé.  
10. Revue indépendante terminée.  
11. Corrections terminées.  
12. Validation manuelle utilisateur.  
13. Décision explicite **GO**.  
14. Aucun blocker ouvert.

> Un build vert seul n’est **jamais** un critère suffisant.

---

## 25. Tests permanents d’architecture

Suite permanente vérifiant notamment :

- Aucun Domain Pipeline n’importe un adapter fournisseur.  
- Router n’importe aucun SDK fournisseur.  
- Review / Conversion / Extraction n’utilisent pas `connectorType`.  
- Aucune constante partenaire / domaine historique dans l’admission cible.  
- Aucune query Platform sans `companyId`.  
- Aucune Connection inter-tenant.  
- Aucun Connector Runtime ne crée un draft.  
- Aucun Normalizer ne route.  
- Aucun Router ne persiste une entité métier.  
- Upload `.eml` n’exige aucune modification du Router ou du Pipeline Consultations.

### 25.1 Matrice de tests par lot (minimum)

| Lot | Tests |
|-----|-------|
| 1A | Contrats ; architecture imports |
| 1B | FK composites ; uniques ; cross-tenant |
| 1C | Sync parity ; envelope ; zéro Draft extra ; un seul poll |
| 2 | Matching ; ambiguity ; shadow ; simulateur ; bornes |
| 3 | Admission unique ; scénarios §11 ; TX ; review/conversion |
| 4 | Workers parity ; no Provider in core |
| 5 | Upload parsing/taille/idempotence ; allowlist intacte |
| 6 | AuthZ triple ; audit admin |
| 7 | Checklist SPEC §42–43 ; décommission |

Filet : `npm run test:acquisition` (sous-ensembles documentés) ; `tsc --noEmit`.

---

## 26. Risques et mitigations

| ID | Sévérité | Risque | Owner | Phase | Détection | Mitigation | Fermeture |
|----|----------|--------|-------|-------|-----------|------------|-----------|
| R1 | Bloquant | SECURITY-SPEC non CLOSED | Platform lead | LOT-0 | Gate G1 | Interdit code avant CLOSED | SECURITY CLOSED sur main |
| R2 | Bloquant | Double Draft | Platform lead | LOT-3 | Métriques + tests §11 | Flags exclusifs + TX + contraintes | Zéro double sur corpus |
| R3 | Bloquant | Cross-tenant | Platform lead | LOT-1B+ | Tests PG + archi | FK/`companyId` partout | Tests verts |
| R4 | Bloquant | Booking cassé | Platform lead | LOT-1C+ | Smoke gmail-scan | Encapsulation §12 | Booking inchangé |
| R5 | Bloquant | Shadow mutatif | Platform lead | LOT-1C/2 | Métriques Draft | Interdits §13.3 | Critères §13.4 |
| R6 | Bloquant | Legacy+New autorités simultanées | Platform lead | LOT-3 | Flag matrix | Invariants §15 | Tests single authority |
| R7 | Bloquant | Workers fournisseur-dépendants avant M5 | Platform lead | LOT-4 | Grep archi | Façade + connectionId | LOT-4 CLOSED |
| R8 | Important | Scope LOT-1 trop large | Platform lead | LOT-1 | Revue allowlist | Découpage 1A/1B/1C | Lots séparés CLOSED |
| R9 | Important | Mauvais cache Rules | Platform lead | LOT-2 | Cache miss/hit + wrong match | Cache tenant + invalidation | Bornes + tests |
| R10 | Important | Admin trop tardive | Product/Platform | LOT-6 | Tentative pilote sans admin | LOT-6 avant pilote réel | LOT-6 CLOSED |
| R11 | Important | SDK prématuré | Architecte | LOT-1A/4 | Revue design | §20–21 bornés | Pas de framework universel |
| R12 | Important | Artifact façade incomplète | Platform lead | LOT-4 | Fuite types | §16.2 | Grep + parity |
| R13 | Important | Migration trop large | Platform lead | LOT-1B/2 | Diff migration | Sous-lots 1B1/1B2/2A/2B | Blast radius limité |
| R14 | Important | Absence métriques shadow | Platform lead | LOT-2 | Obs manquante | Obs dès LOT-1C/2 | Critères §13.4 |
| R15 | Mineur | Nomenclature / ergonomie | Product | LOT-6+ | Feedback UX | Itérations admin | Hors bloquant V1 |
| R16 | Mineur | Stats avancées / connecteurs futurs | Platform | LOT-7+ | Scope creep | Refus PR hors V1 | Annexe A |

---

## 27. Critères de fermeture du programme IMPL V1

1. LOT-1A…5 **CLOSED**.  
2. LOT-6 **CLOSED** (obligatoire — pas de report silencieux).  
3. Critères SPEC §43 satisfaits.  
4. Shadow éteint après parité ou justifié.  
5. SECURITY-SPEC respectée en staging/prod.  
6. Runbook rollback bascule Draft disponible.  
7. Décommission planifiée avec preuves.

**MODULE CLOSED** production = hors ce IMPL-PLAN (PRR dédié ultérieur).

---

## 28. Non-objectifs IMPL V1

- 2ᵉ Provider mail (M5bis)  
- Fan-out multi-pipelines  
- DOCUMENT / EVENT runtime  
- Unification Booking / « Booking utilisera la Platform »  
- Refonte Review / Conversion  
- Event bus / iPaaS  
- SDK Pipeline générique  
- Auth/pagination/protocole universels Connector SDK  

---

## 29. Conformité gouvernance

```text
SPEC v1.1.0 R1 ✓ → SPEC-REVIEW → SECURITY-SPEC CLOSED → IMPL-PLAN R1 (ce doc)
  → ARCHITECTURE REVIEW → branche Platform dédiée → IMPL lots séquentiels
  → Independent Review par lot → … → PRR / MODULE CLOSED (séparé)
```

Aucun commit/PR imposé par ce document.  
Docs Platform **jamais** dans une PR ACQ-005.

---

## 30. Verdict du plan

**READY FOR ARCHITECTURE REVIEW**

*Fin PLAN-INTEGRATION-PLATFORM-001-IMPL-PLAN v1.1.0 (R1)*
