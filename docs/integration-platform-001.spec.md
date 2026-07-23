# PLAN-INTEGRATION-PLATFORM-001-SPEC

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-INTEGRATION-PLATFORM-001-SPEC |
| **Version** | **1.1.0 (R1)** |
| **Statut** | Normatif consolidé — lot SPEC-R1 (corrections REVIEW-001 + §9–43) |
| **Programme** | PLAN-INTEGRATION-PLATFORM-001 |
| **Fichier canonique** | `docs/integration-platform-001.spec.md` |
| **Bases** | PLAN-INTEGRATION-PLATFORM-001-AUDIT ; brouillon conversationnel v1.0.0 (**non normatif**) ; PLAN-INTEGRATION-PLATFORM-001-SPEC-REVIEW-001 ; architecture Acquisition sur `main` ; OPS-001→004 ; Review 005C / PLAN-ACQ-005 ; Conversion 005D ; Booking/logements legacy ; ENGINEERING-STANDARD-001 ; PLAN-GOVERNANCE-001 |
| **Date** | 2026-07-23 |
| **Migration (ce lot SPEC)** | **`NO MIGRATION`** |
| **Code (ce lot SPEC)** | **Aucun** |

### Gouvernance de vérité

1. **Seul** ce fichier dans le dépôt est source de vérité de la SPEC Platform.  
2. Un livrable conversationnel **n’est pas** une SPEC.  
3. Toute revue ultérieure DOIT auditer **ce fichier**, pas un rapport de chat.

---

## 0. Nomenclature (stable)

| Terme | Définition normative |
|-------|----------------------|
| **Provider** | Système ou protocole **externe**. Descriptif uniquement — jamais entité métier, jamais enum partenaires |
| **ConnectorType** | Identifiant technique du runtime d’intégration (registry produit) |
| **IntegrationConnection** | Instance d’intégration d’**une** Company vers **un** ConnectorType |
| **InboundEnvelope** | Unité brute reçue, opaque au métier |
| **Family Normalizer** | Transforme Envelope → NormalizedInbound ; **aucune** décision d’admission |
| **NormalizedInbound** | **Seul** contrat visible par les Domain Pipelines |
| **InboundSource** | Source logique métier configurable par Company — **données** |
| **InboundSourceRule** | Règle de reconnaissance (IDENTITÉ ou QUALIFICATIVE) |
| **PipelineBinding** | Liaison **une** Source → **un** Pipeline (V1) |
| **Domain Pipeline** | Pipeline métier (ex. `consultations`) — ignore Provider et ConnectorType |
| **InboundArtifact** | Référence logique pièce/fichier (façade) — pas de schéma physique imposé ici |
| **Shadow mode** | Comparaison ancien/nouveau chemin **sans** effet métier (pas de Draft) |
| **AcquisitionSource** (Prisma actuel) | Enum historique canal ACQ (`GMAIL`) — **≠** InboundSource |
| **Booking legacy** | Pipeline logements hors Platform V1 |

---

## 1. Objectif

Chaque Company DOIT pouvoir configurer Connections, Sources, Rules et Bindings vers des Domain Pipelines **sans** modifier le cœur métier des pipelines et **sans** dépendre d’un Provider / protocole / SDK / format brut dans la logique métier.

```text
IntegrationConnection
        ↓
Connector Runtime
        ↓
InboundEnvelope
        ↓
Family Normalizer
        ↓
NormalizedInbound
        ↓
Tenant Router
        ↓
PipelineBinding
        ↓
Domain Pipeline
```

---

## 2. Décision architecturale

**Modèle retenu :** Hexagonal Connector Platform + NormalizedInbound + Tenant Router + Domain Pipelines.

**Interdit en V1 :** bus obligatoire, event sourcing, orchestration saga, marketplace connecteurs, moteur workflow générique, iPaaS low-code.

---

## 3. Périmètre V1 (strict)

### 3.1 Implémentable

| Élément | V1 |
|---------|-----|
| Famille **MESSAGE** | **Oui — seule famille runtime** |
| Connector Runtime mail (strangler) | Oui |
| Mode UPLOAD MESSAGE (`.eml`, preuve M5) | Oui |
| InboundSource / Rules MESSAGE | Oui |
| Binding Source → `consultations` (1:1) | Oui |
| Tenant Router + Shadow mode | Oui |

### 3.2 Réservé (non implémentable V1)

| Élément | Statut |
|---------|--------|
| Famille `DOCUMENT` | Variante réservée — **Annexe A** |
| Famille `EVENT` | Variante réservée — **Annexe A** |
| Fan-out multi-pipelines | **Reporté** — §17 |
| API / FTP / webhook générique comme livrables | Hors V1 |

### 3.3 Exclus V1

Booking ; modification métier Review/Conversion ; admin client de ConnectorTypes.

---

## 4. Couches et dépendances

| Couche | PEUT dépendre de | NE DOIT PAS dépendre de |
|--------|------------------|-------------------------|
| Connector Runtime | Connection, SDK/protocole local | Domain Pipeline, Sources, Rules, partenaires |
| Family Normalizer | Envelope, schémas famille | Sources, Rules, Pipelines, admission métier, partenaires |
| Tenant Router | NormalizedInbound, Sources, Rules, Bindings | SDK, Connector Runtime, Provider |
| Domain Pipeline | **NormalizedInbound uniquement** (+ façade InboundArtifact) | Provider, ConnectorType, SDK, Envelope brut |

---

## 5. IntegrationConnection (aperçu)

Norme détaillée : **§21**.  
Résumé : Connection = **unique autorité** pour qu’un Connector Runtime fonctionne ; `status` ∈ {`ACTIVE`,`DISABLED`,`ERROR`,`PENDING_AUTH`} (+ `ARCHIVED`) ; health runs ; **aucun secret en clair** ; `config` publique uniquement ; secrets via **Secret Provider** (§22).

---

## 6. Security — dépendance normative

Norme détaillée : **§22**.  
**`PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC`** est **obligatoire avant toute implémentation** Platform (P1+).  
La présente SPEC ne décrit que les **responsabilités** ; le stockage/rotation/audit des secrets est hors détail ici.

---

## 7. Matching — sémantique normative V1

### 7.1 Interdictions

- **Supprimé / interdit :** « OR intra-source » global (toute rule suffit).  
- **Interdit :** qu’un simple mot-clé (`SUBJECT_KEYWORD` / `BODY_KEYWORD`) **suffise** à admettre un inbound.  
- **Interdit :** attribution automatique en cas d’ambiguïté (§16).

### 7.2 Règle normative

Une Source est **candidate valide** (match source) **uniquement si** :

```text
(identity1 OR identity2 OR …)          — ≥ 1 règle IDENTITÉ enabled matche
AND
(
  aucune règle QUALIFICATIVE enabled
  OR
  (qualifier1 OR qualifier2 OR …)     — ≥ 1 qualificatif enabled matche
)
AND
(scope Connection respecté SI configuré)
```

Formellement : **IDENTITÉ obligatoire** ; qualificatifs **facultatifs en configuration**, mais **obligatoires à satisfaire** dès qu’au moins un qualificatif enabled existe.

### 7.3 Types de rules MESSAGE (V1 fermée)

#### Classe IDENTITÉ

| `type` | Sémantique |
|--------|------------|
| `SENDER_EMAIL` | Adresse expéditeur exacte (normalisée) |
| `SENDER_DOMAIN` | Domaine expéditeur exact (normalisé) |

#### Classe QUALIFICATIVE

| `type` | Sémantique |
|--------|------------|
| `SUBJECT_KEYWORD` | Sous-chaîne dans subject normalisé |
| `BODY_KEYWORD` | Sous-chaîne dans corps ; si corps absent ⇒ cette rule **ne matche pas** |
| `RECIPIENT_EMAIL` | Destinataire exact ; si champ absent ⇒ cette rule **ne matche pas** |

Rules DOCUMENT / EVENT : **hors V1** — **Annexe A**.

### 7.4 Intégrité admin

- Source `enabled=true` ⇒ **≥ 1** rule IDENTITÉ `enabled=true` (sinon refus sauvegarde).  
- Source / Rule `enabled=false` ⇒ ignorée.  
- Comparaison : **uniquement** `normalizedValue` (§15).

### 7.5 PipelineBinding V1

- Exactement **une** Source → **un** Pipeline actif (`consultations`).  
- Fan-out multi-pipelines : **interdit en V1** (§17).  
- Scope Connection optionnel.

### 7.6 Zéro Source / zéro Binding actif

Décision Router `NO_MATCH` ou `NO_ACTIVE_BINDING` (§16) — jamais de fallback code partenaire.

---

## 8. InboundEnvelope (aperçu)

Champs : `id`, `companyId`, `connectionId`, `connectorType`, `externalId`, `idempotencyKey`, `receivedAt`, `payloadRef`, `contentType`, `schemaVersion`, `lifecycleStatus`.  
Cycle de vie normatif détaillé : **§23**. Rétention payloads : **§24**.

---

## 9. NormalizedInbound

### 9.1 Statut normatif

`NormalizedInbound` est le **seul contrat visible** par les Domain Pipelines.

Les pipelines **NE DOIVENT PAS** :

- lire `InboundEnvelope` brut ;  
- appeler un Connector Runtime ;  
- dépendre d’un Provider.

### 9.2 Contrat discriminant — champs communs **obligatoires**

| Champ | Norme |
|-------|--------|
| `schemaVersion` | Version du contrat normalisé |
| `normalizedHash` | Hash du contenu normalisé pertinent |
| `family` | Discriminant ; runtime V1 = `MESSAGE` |
| `companyId` | Tenant |
| `connectionId` | Connection d’origine |
| `envelopeId` | Envelope source |
| `occurredAt` | Horodatage métier si connu, sinon = `receivedAt` |
| `receivedAt` | Réception Platform |
| `artifactRefs` | Liste de refs `InboundArtifact` |

**Interdit au contrat racine (toutes familles) :** imposer `senderEmail`, `subject`, `body` / `bodyRef`.  
Ces champs appartiennent **uniquement** à la variante **MESSAGE**.

### 9.3 Variantes

| Variante | V1 |
|----------|-----|
| **MESSAGE** | **Seule variante réellement utilisée** |
| DOCUMENT | Réservée — Annexe A |
| EVENT | Réservée — Annexe A |

### 9.4 Variante MESSAGE (champs spécifiques)

| Champ | Norme |
|-------|--------|
| Expéditeur | email + domain normalisés (si applicable) |
| Destinataires | Si disponibles |
| `subject` | Si disponible — **MESSAGE only** |
| `bodyRef` | Corps normalisé ou null si fetch différé — **MESSAGE only** |
| `externalMessageId` | Obligatoire pour fetch différé |
| Capacités | `CONTENT_FETCHABLE` \| `ATTACHMENTS_FETCHABLE` \| `CONTENT_INLINE` |

### 9.5 Capacités et workers

Résolution des ports content/attachments **uniquement** via `connectionId` — jamais via types Provider dans le Domain Pipeline.

---

## 10. InboundArtifact

### 10.1 Concept logique

`InboundArtifact` est un **contrat logique** de pièce/fichier.  
Ce SPEC **n’impose pas** de schéma physique (tables/colonnes).

### 10.2 Contrat logique minimum

| Champ | Norme |
|-------|--------|
| `artifactId` | Identifiant logique opaque |
| `storageRef` | Référence de stockage opaque |
| `mimeType` | Type MIME |
| `size` | Taille en octets |
| `hash` | Empreinte contenu (si disponible) |
| `availability` | Ex. `AVAILABLE` \| `PENDING_FETCH` \| `FAILED` \| `UNAVAILABLE` |

### 10.3 Strangler

Durant le strangler :

- le **stockage réel** PEUT rester les artefacts Acquisition (attachments) ;  
- les Domain Pipelines et workers métier **NE DOIVENT dépendre que** de la **façade générique** `InboundArtifact` / ports associés ;  
- le Domain Pipeline **ne connaît jamais** un Provider.

**Stratégie :** façade générique + persistance ACQ derrière (option C).  
Interdit : big-bang migration fichiers ; dépendance durable aux types Provider après M4.

---

## 11. Family Normalizer

### 11.1 Responsabilité unique

```text
InboundEnvelope  →  NormalizedInbound
```

### 11.2 Frontière renforcée

Le Family Normalizer :

| DOIT | NE DOIT JAMAIS |
|------|----------------|
| Produire un `NormalizedInbound` versionné | Décider des Sources |
| Appliquer la normalisation famille MESSAGE | Décider des Rules |
| Signaler échec `NORMALIZE_FAILED` | Décider des Pipelines |
| | Décider de l’admission métier |
| | Connaître une règle partenaire |
| | Créer un Draft |
| | Appeler Review / Conversion / workers métier |

---

## 12. Tenant Router

### 12.1 Autorité unique de routage

Le Router est la **seule** autorité de routage Platform.

### 12.2 Entrées exclusives

- `NormalizedInbound`  
- Sources de **la même** `companyId`  
- Rules de **la même** `companyId`  
- Bindings de **la même** `companyId`  

### 12.3 Décisions (outcomes)

| Outcome | Signification |
|---------|----------------|
| `MATCH` | Exactement une Source valide + Binding actif applicable (V1) |
| `NO_MATCH` | Aucune Source ne satisfait §7 |
| `NO_ACTIVE_BINDING` | Source(s) matchent mais aucun Binding actif |
| `AMBIGUOUS_SOURCE` | Plusieurs Sources valides sans règle de départage V1 |
| `DUPLICATE` | Idempotence : déjà traité / déjà admis |
| `ERROR` | Erreur technique de routage |

### 12.4 Interdits Router

- Créer un Draft  
- Connaître un SDK  
- Connaître un Connector Runtime  
- Attribuer automatiquement en cas d’ambiguïté  

---

## 13. Matching (renvoi normatif)

La définition complète est **§7**.  
Rappel : identité obligatoire ; qualificatifs optionnels en config mais conjoints dès qu’ils existent ; mot-clé seul **interdit** pour admission.

---

## 14. Types de rules (renvoi)

Voir **§7.3**. DOCUMENT/EVENT → **Annexe A**.

---

## 15. Normalisation des valeurs de rules

Toute comparaison de matching utilise **uniquement** `normalizedValue`.  
**Interdit** d’utiliser la valeur brute `value` pour matcher.

| Domaine | Règles de normalisation serveur (à la persistance admin) |
|---------|----------------------------------------------------------|
| **Emails** | trim + lowercase (+ extraction adresse réelle si forme display-name, principes ACQ) |
| **Domaines** | trim + lowercase ; **comparaison exacte** |
| **Sous-domaines** | **Non matchés** par défaut (`user@mail.example.com` ≠ règle `example.com`) |
| **Keywords** | trim + lowercase + **Unicode normalization** (forme à figer en IMPL-PLAN, ex. NFC) |

---

## 16. Ambiguïtés et outcomes Router

### 16.1 Distinction obligatoire

Le Router DOIT distinguer au minimum :

`MATCH` | `NO_MATCH` | `AMBIGUOUS_SOURCE` | `DUPLICATE` | `NO_ACTIVE_BINDING` | `ERROR`

### 16.2 Norme d’ambiguïté

- **Aucune ambiguïté** ne provoque une **attribution automatique** à une Source ou un Pipeline.  
- Toute ambiguïté (`AMBIGUOUS_SOURCE`, et tout conflit non résolu) est **traçable** (event + ids candidats).  
- Pas de Draft sur `AMBIGUOUS_SOURCE`, `NO_MATCH`, `NO_ACTIVE_BINDING`, `ERROR`.  
- `DUPLICATE` : pas de second Draft (§19).

---

## 17. Fan-out — V1 simple

### 17.1 Décision V1

```text
Une Source  →  un seul Pipeline actif
```

Le **fan-out** (une Source → plusieurs Pipelines ; un inbound → plusieurs pipelines) est **reporté** à une évolution future.

### 17.2 Justification normative

Cette décision réduit fortement :

- la complexité opérationnelle ;  
- les retries croisés ;  
- les partial failures ;  
- la gouvernance (une admission = un pipeline).

Un Binding V1 : `companyId` + `sourceId` + `pipelineId=consultations` + `enabled` (+ scope Connection optionnel).  
Contrainte d’unicité logique V1 : au plus **un** Binding actif par Source.

---

## 18. Multi-tenant

| Entité | Norme |
|--------|--------|
| IntegrationConnection | Appartient à **une seule** Company |
| InboundSource | Appartient à **une seule** Company |
| InboundSourceRule | Appartient à **une seule** Company |
| PipelineBinding | Appartient à **une seule** Company |
| InboundEnvelope / NormalizedInbound | Portent `companyId` de cette Company |

Le Router **n’évalue jamais** Sources / Rules / Bindings d’une autre Company.  
**Connexions partagées inter-tenant : interdites en V1.**

---

## 19. Idempotence — niveaux

| Niveau | Norme |
|--------|--------|
| **Envelope** | Une clé `idempotencyKey` (défaut company+connection+externalId) ⇒ au plus une envelope effective |
| **Normalization** | Rejeu normalizer sur même envelope ⇒ même `normalizedHash` / pas de divergence silencieuse |
| **Routing** | Rejeu Router ⇒ même outcome pour mêmes données ; `DUPLICATE` si déjà admis |
| **Pipeline** | Dispatch idempotent par clé d’admission |
| **Draft** | **Un replay NE PEUT JAMAIS produire un second Draft** |
| **Shadow** | **NE PEUT JAMAIS** créer de Draft ni second Draft (§20) |

Rappel strangler : un seul chemin d’écriture Draft actif à la fois (flag de bascule) ; tests anti double Draft / double message obligatoires.

---

## 20. Shadow mode (aperçu)

Norme stricte : **§28**.  
Shadow = observer / comparer / journaliser. **Legacy reste l’unique autorité métier** tant que le shadow est actif. **Aucun effet métier.**

---

## 21. Connection — norme complète

### 21.1 Autorité Runtime

Une **IntegrationConnection** est l’**unique autorité** permettant à un Connector Runtime de fonctionner pour un tenant donné.

Sans Connection `ACTIVE` valide :

- aucun PULL / PUSH / UPLOAD Platform ;
- aucun accès Secret Provider pour ce canal ;
- aucun listing tenant « à synchroniser » via ce canal.

### 21.2 `status` (normatif)

| Valeur | Signification |
|--------|----------------|
| `ACTIVE` | Runtime autorisé |
| `DISABLED` | Coupure admin — aucun nouveau run |
| `ERROR` | Santé dégradée — politique IMPL-PLAN (blocage ou alerte) |
| `PENDING_AUTH` | Auth/reconnexion requise — Runtime non opérationnel |

`ARCHIVED` : soft-retrait historique (plus de runs) — complémentaire à `DISABLED`.

### 21.3 Santé / runs (champs explicites)

| Champ | Norme |
|-------|--------|
| `lastSuccessfulRun` | Horodatage du dernier run Runtime réussi |
| `lastFailedRun` | Horodatage du dernier run Runtime échoué |
| `lastHealthCheck` | Horodatage du dernier contrôle de santé |

Autres champs Connection : `id`, `companyId`, `connectorType`, `displayName`, `cursor`/watermark, `config`, référence Secret Provider, timestamps. Orientation physique : table générique + config publique + Secret Provider (**A**) ; table par Provider **rejetée**.

### 21.4 Secrets et `config`

- Une Connection **ne contient jamais** de secret **en clair**.
- `config` ne contient **que** des paramètres **publics** (non secrets).
- Les secrets sont **toujours** référencés via un **Secret Provider** (contrat défini dans SECURITY-SPEC §22).
- Interdit : secrets dans JSON `config` ; tokens dans logs ou UI.

### 21.5 Multi-instance

N Connections / Company autorisé. **Aucune** Connection partagée inter-tenant (V1).

---

## 22. Security — dépendance normative

### 22.1 Gate d’implémentation

```text
PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC
```

est **obligatoire avant toute implémentation** Platform (code, migration Connection/secrets, P1+).

Sans SECURITY-SPEC revue : **interdit** de démarrer l’IMPL-PLAN exécutable sur les secrets / credentials.

### 22.2 Répartition des responsabilités

| Document | Rôle |
|----------|------|
| **Platform SPEC (présent)** | Responsabilités : Connection unique pour Runtime ; `config` publique ; Secret Provider ; AuthZ triple contrôle ; logs sans secrets |
| **SECURITY-SPEC** | Définit : secret storage, rotation, revocation, audit, permissions, encryption, master keys, backup, restore |

Le présent document **renvoie** vers `PLAN-INTEGRATION-PLATFORM-001-SECURITY-SPEC` pour tout détail cryptographique ou de coffre.

---

## 23. Envelope lifecycle

### 23.1 Cycle normatif

```text
RECEIVED
    ↓
NORMALIZED
    ↓
ROUTED
    ↓
DISPATCHED
    ↓
ARCHIVED

— branches d’échec / non-admission —

NORMALIZE_FAILED
    ↓
NO_MATCH          (ou AMBIGUOUS_SOURCE / NO_ACTIVE_BINDING / ERROR selon §16)
    ↓
DISCARDED
```

Variantes de non-admission (`DUPLICATE`, etc.) aboutissent aussi à un état terminal **sans** `DISPATCHED` métier.

### 23.2 Indépendance

Ce cycle Envelope est **indépendant** des Domain Pipelines :

- un Pipeline peut avoir son propre cycle Draft/Review ;
- l’état Envelope **ne duplique pas** le statut `WorksiteImportDraft` ;
- archiver / discard une Envelope **n’efface pas** l’historique métier pipeline (§24).

---

## 24. Retention

### 24.1 Politique

La rétention des **payloads bruts** est une **politique Ops**, pas une propriété du Connector ni du Pipeline.

| Règle | Norme |
|-------|--------|
| Indépendance Connector | La durée ne dépend pas du ConnectorType |
| Indépendance Pipeline | La durée ne dépend pas de `consultations` / Review |
| Suppression payload | **Ne doit jamais** supprimer l’historique métier (Draft, review, conversion, décisions Router) |
| Durées | **Non fixées** dans ce document |

Les durées seront définies dans une **SPEC Ops** dédiée (rétention Platform).

---

## 25. Observabilité

### 25.1 Events structurés par étape

Chaque étape DOIT produire des événements structurés :

| Étape | Domaine d’events |
|-------|------------------|
| Connection | statut, health, reconnect |
| Runtime | run start/end, erreurs |
| Envelope | lifecycle transitions |
| Normalizer | OK / FAILED |
| Router | MATCH / NO_MATCH / AMBIGUOUS / … |
| Dispatcher | dispatch / skip |
| Pipeline | admission / reject pipeline (hors shadow) |

### 25.2 Contenu interdit dans les logs

Aucun :

- secret
- token
- body
- attachment (contenu / raw)
- PII interdite (alignement Review / ES-001)

### 25.3 Labels minimum

`companyId` · `connectionId` · `connectorType` · `pipelineId` · `durationMs` · `result`

---

## 26. Workers (OPS-002 / OPS-003 / OPS-004)

### 26.1 Norme cible

Les workers **ne doivent plus** résoudre un **fournisseur** (Provider) nommé.

Résolution obligatoire :

```text
connectionId
    ↓
Connector Capability
    ↓
Artifact Provider  (façade / ports — pas SDK Provider dans le worker métier)
```

### 26.2 Strangler

Cette migration de résolution **fait partie du strangler** (phase **M4** — parité workers).  
Tant que M4 n’a pas sa parité, la dette « défaut Provider » est **assumée et bornée**, pas un état cible.

---

## 27. Feature flags

### 27.1 Kill switch Platform

| Flag logique | Rôle |
|--------------|------|
| **`PLATFORM_MASTER`** | Kill switch **global** Platform |

(Nom env exact = IMPL-PLAN ; le concept normatif est `PLATFORM_MASTER`.)

### 27.2 Flags Domain Pipelines

Les Domain Pipelines **conservent** leurs propres flags (`ACQUISITION_REVIEW_*`, conversion, extraction, etc.).

### 27.3 Comportement Platform OFF

```text
PLATFORM_MASTER = OFF
    ↓
aucune nouvelle admission Platform
    ↓
MAIS les pipelines existants continuent les traitements déjà commencés
```

Exemples : Review/Conversion/extraction déjà en cours sur Drafts existants **ne sont pas** brutalement stoppés par le seul kill switch Platform.

---

## 28. Shadow / Strangler — règle stricte

### 28.1 Shadow

| Autorisé | Interdit |
|----------|----------|
| Observer | Créer Draft |
| Comparer | Déclencher Review |
| Journaliser | Déclencher Conversion |
| | Appeler workers métier en écriture |
| | Toute admission effective |

**Le Legacy reste l’unique autorité métier** pendant le shadow.  
Shadow = **rien d’autre** qu’observer / comparer / journaliser.

### 28.2 Critères de sortie shadow

Parité routing · parité idempotence · absence de double admission.

---

## 29. Migration M0 → M5

### 29.1 Principe fondamental

> Une phase **ne commence jamais** si la précédente **n’a pas atteint sa parité** (critère de sortie).

### 29.2 Phases et critères de sortie

| Phase | Objectif | Critère de sortie (parité) |
|-------|----------|----------------------------|
| **M0** | SPEC Platform + SECURITY-SPEC + IMPL-PLAN | Artefacts repo revus |
| **M1** | Foundations Connection / Envelope / Normalize MESSAGE | **Parité du Runtime** |
| **M2** | Sources / Rules / Bindings ; fin hardcode | **Parité du Matching** |
| **M3** | Draft via Pipeline only ; anti dual-write | **Parité des Drafts** |
| **M4** | Workers via connectionId → capabilities | **Parité des Workers** |
| **M5** | Upload `.eml` | **Preuve d’extensibilité** (§30) |

Shadow : en parallèle de M2–M3 selon IMPL-PLAN, sous §28.

---

## 30. Preuve M5 — décision normative

### 30.1 Obligation

**Supprimé :** choix « ConnectorType **ou** Upload ».

**Remplacé par (obligatoire) :**

- Upload **`.eml`**
- Mode **UPLOAD**
- Famille **MESSAGE**

### 30.2 Démonstration

Cette preuve DOIT démontrer qu’**aucun** changement n’a été nécessaire dans :

- Tenant Router
- Domain Pipeline Consultations
- Review
- Conversion

### 30.3 M5bis

Un **deuxième Connector Runtime** (ex. second Provider mail) devient **M5bis**, **pas** M5.

---

## 31. Administration

### 31.1 Opérations normatives

| Domaine | Opérations |
|---------|------------|
| Connection | Créer · Modifier · Reconnecter · Désactiver · Réactiver |
| Source | Créer · Modifier |
| Rule | Créer · Modifier |
| Binding | Créer · Modifier |

(Suppression / archive : selon politiques Connection `ARCHIVED` et intégrité référentielle — IMPL-PLAN.)

### 31.2 Journalisation

**Toutes** ces opérations sont **journalisées** (qui, companyId, entité, action, résultat — sans secrets).

AuthZ rôles : ADMIN / SUPER_ADMIN + `companyId` de session.

---

## 32. Authorization

Toutes les **écritures** Platform DOIVENT respecter la **même discipline** que Review :

```text
Page  →  Action  →  Service
```

**Triple contrôle** obligatoire.  
**Aucune** validation **uniquement** côté UI.  
Service = autorité (ES-001) : tenant, AuthZ, Zod, TX.

---

## 33. Pipeline Consultations — consommateur

Le Pipeline Consultations est désormais un **consommateur**.

| Il ne décide plus | Il ne connaît pas | Il reçoit seulement |
|-------------------|-------------------|---------------------|
| De l’admission (Router) | `connectorType` | `NormalizedInbound` |
| | Connector Runtime | Artifact Provider (façade) |
| | SDK / Provider | Configuration métier pipeline |

Création de Draft : uniquement après `MATCH` hors shadow, sous autorité Pipeline (cible M3+).  
Review / Conversion : inchangés en responsabilités internes.

---

## 34. Booking

Booking / logements **reste totalement isolé**.

- Aucun composant Booking **ne dépend** de la Platform V1.
- Aucun branchement Booking → Router / Sources Platform.
- Toute convergence future **nécessite une SPEC dédiée**.

---

## 35. Acquisition legacy

`registerIncomingMessage` devient un **adaptateur temporaire** du strangler.

- Il **ne constitue plus** l’autorité de routage (cible : Tenant Router).
- Sa **disparition** (ou réduction à une façade pure) fait partie de la **roadmap** strangler (autour de M2–M3).
- La constante domaine / partenaire hardcodée est **interdite** en état cible (§36).

---

## 36. Constantes métier — interdictions

| Interdit | Norme |
|----------|--------|
| Constante métier de **partenaire** | **Interdite** |
| Constante de **domaine** (admission) | **Interdite** |
| Liste de partenaires en code / enum | **Interdite** |

Toutes les décisions d’admission / matching proviennent des **données administrées** par chaque Company (Sources, Rules, Bindings, Connections).

---

## 37. Matching — règle définitive

### 37.1 Remplacement

Toute logique « OR intra-source global » est **supprimée**. La règle suivante est **seule** normative.

### 37.2 Règle

Une Source **matche** si et seulement si :

```text
( ≥ 1 règle IDENTITÉ enabled matche )
AND
(
  aucune règle QUALIFICATIVE enabled n’existe
  OR
  ≥ 1 règle QUALIFICATIVE enabled matche
)
```

**Interdit :** qu’un seul mot-clé (ou toute QUALIFICATIVE seule) suffise à admettre un inbound.

### 37.3 Classes de rules (V1)

| Classe | Types |
|--------|--------|
| **IDENTITÉ** | `SENDER_EMAIL`, `SENDER_DOMAIN` |
| **QUALIFICATIVE** | `SUBJECT_KEYWORD`, `BODY_KEYWORD`, `RECIPIENT_EMAIL` |

`DOCUMENT` et `EVENT` (familles et rules associées) sont **exclus de V1** (Annexe A).

### 37.4 Intégrité d’activation

Une Source **ne peut jamais être activée** (`enabled=true`) sans **au moins une** rule IDENTITÉ `enabled=true`.  
Sinon : rejet de validation serveur (admin).

Le matching utilise **uniquement** `normalizedValue` (§15).

---

## 38. NormalizedInbound — contrat complété

### 38.1 Obligatoire

| Champ | Norme |
|-------|--------|
| `schemaVersion` | **Obligatoire** |
| `normalizedHash` | Obligatoire |
| `family` | Discriminant ; runtime V1 = `MESSAGE` |
| `companyId` | Obligatoire |
| `connectionId` | Obligatoire |
| `envelopeId` | Obligatoire |
| `occurredAt` / `receivedAt` | Obligatoires |
| `artifactRefs` | Refs façade InboundArtifact |

### 38.2 Workers — références sans Provider

Le Domain Pipeline **ne doit jamais relire le fournisseur (Provider)**.

Les workers DOIVENT disposer des références permettant de récupérer les artifacts **uniquement** via :

```text
connectionId  →  Connector Capability  →  Artifact Provider (façade)
```

Champs MESSAGE utiles : `externalMessageId`, `bodyRef` (si inline), `artifactRefs`, capacités (`CONTENT_FETCHABLE`, `ATTACHMENTS_FETCHABLE`, `CONTENT_INLINE`).

`senderEmail` / `subject` / `body` : **uniquement** variante MESSAGE — jamais imposés au contrat racine.

---

## 39. InboundArtifact — façade normative

`InboundArtifact` est une **abstraction** (contrat logique : `artifactId`, `storageRef`, `mimeType`, `size`, `hash`, `availability`).

| Pendant le strangler | Norme |
|----------------------|--------|
| Persistance réelle | PEUT rester Acquisition (attachments) |
| Domain Pipelines | Dépendent **uniquement** de la façade |
| Workers | **Aucun** ne doit connaître le Provider |

Schéma physique non imposé par ce SPEC.

---

## 40. Terminologie — tableau de correspondance

| Terme | Signifie | N’est pas |
|-------|----------|-----------|
| **Provider** | Acteur / système **externe** | Entité Planificator, Source métier |
| **ConnectorType** | Runtime technique (registry) | Partenaire, Pipeline |
| **IntegrationConnection** | Instance tenant d’un ConnectorType | Source métier |
| **InboundSource** | Source **métier** configurable | ConnectorType, Provider |
| **InboundSourceRule** | Règle de reconnaissance | Constante code |
| **Pipeline** / Domain Pipeline | **Consommateur** métier | Runtime, Provider |
| **NormalizedInbound** | Seul contrat visible des Pipelines | Envelope brut |
| **AcquisitionSource** | **Legacy** enum canal ACQ (`GMAIL`) | InboundSource, ConnectorType |

---

## 41. Interdits Platform

La Platform **interdit** :

| Interdit |
|----------|
| Enum partenaires |
| Domaines hardcodés (admission) |
| Emails hardcodés (admission) |
| Provider SDK dans les Domain Pipelines |
| `ConnectorType` dans Review |
| `ConnectorType` dans Conversion |
| `ConnectorType` dans Extraction (métier) |
| `ConnectorType` dans le Tenant Router (décision métier) |

Le Router travaille sur NormalizedInbound + Sources/Rules/Bindings uniquement.  
`connectorType` sur Envelope/Connection reste **traçabilité bordure / obs**, pas critère de matching métier.

---

## 42. Tests d’architecture — preuves minimales

### 42.1 Isolation multi-tenant

```text
Company A → ses Sources → son Pipeline
Company B → ses Sources → son Pipeline
Aucun cross-match.
```

### 42.2 Scénarios obligatoires

| Scénario | Attendu |
|----------|---------|
| Connection OFF (`DISABLED` / non `ACTIVE`) | Aucun run Runtime / pas d’admission |
| Source OFF | Ignorée |
| Rule OFF | Ignorée |
| Binding OFF | `NO_ACTIVE_BINDING` ou équivalent ; pas de Draft |
| `NO_MATCH` | Pas de Draft |
| `MATCH` | Dispatch Pipeline (hors shadow) |
| Double réception | Idempotence ; pas de double Draft |
| Replay | Pas de second Draft |
| Rotation secret | Via Secret Provider ; journalisée ; pas de secret en clair |
| Upload `.eml` (M5) | Admission MESSAGE sans changer Router/Review/Conversion |
| Shadow Mode | Observe only ; Legacy = autorité ; zéro effet métier |
| Migration legacy | `registerIncomingMessage` adaptateur ; Router = autorité cible |

---

## 43. Critères d’acceptation Platform

La Platform est **conforme** uniquement si :

1. Aucun Pipeline ne connaît le Provider.  
2. Aucune règle d’admission n’est codée en dur.  
3. Aucun partenaire n’est codé en dur.  
4. **Review** reste inchangé (contrat d’entrée normalisé uniquement).  
5. **Conversion** reste inchangée.  
6. **Booking** reste inchangé.  
7. L’ajout d’un nouveau Connector Runtime est possible **sans** modifier : Tenant Router, contrat `NormalizedInbound`, Pipeline Consultations.

---

## 44. Tests d’acceptance complémentaires (synthèse)

Inclut §37–43 et scénarios §42, en plus des tests §25 / §37 antérieurs (renumérotés ici comme couverture globale).

---

## 45. Décisions tranchées (R1 consolidée v1.1.0)

| Sujet | Décision |
|-------|----------|
| Matching | IDENTITÉ ∧ (∅ QUALIF ∨ OR QUALIF) ; intégrité Source |
| NormalizedInbound | `schemaVersion` obligatoire ; refs workers via connectionId |
| InboundArtifact | Façade ; ACQ derrière pendant strangler |
| Terminologie | Tableau §40 |
| Interdits | §41 |
| M5 | Upload `.eml` MESSAGE ; M5bis = 2ᵉ Runtime |
| Security | SECURITY-SPEC avant toute implémentation |
| Shadow | Legacy autorité ; zero side-effect |
| Migration | Parité avant phase suivante |

---

## 46. Points ouverts

SECURITY-SPEC (contenu) ; SPEC Ops rétention (durées) ; schéma physique ; nom env `PLATFORM_MASTER` ; date fin shadow.  
**Ne rouvrent pas** §45.

---

## 47. Conformité gouvernance

`AUDIT → SPEC v1.1.0 R1 (ce fichier) → SPEC-REVIEW → SECURITY-SPEC → IMPL-PLAN → …`

---

## 48. Historique

| Version | Date | Nature |
|---------|------|--------|
| 1.0.0 | 2026-07-22 | Brouillon conversationnel — **non normatif** |
| **1.1.0 (R1)** | 2026-07-23 | **Version canonique dépôt du lot SPEC-R1** (consolidation REVIEW-001 + §9–43) |
| 1.2.x / 1.3.x | 2026-07-23 | Incréments de travail fusionnés dans 1.1.0 R1 |

---

## Annexe A — Future Version (non V1)

Familles `DOCUMENT` / `EVENT` ; rules associées ; fan-out multi-pipelines — hors V1.

---

## 49. Verdict de lot SPEC-R1

**READY FOR SPEC-REVIEW**

*Fin PLAN-INTEGRATION-PLATFORM-001-SPEC v1.1.0 R1*
