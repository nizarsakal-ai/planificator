# Assistant Consultations — Fondation (PLAN-ACQ-001)

## Objectif

Fondation persistante, testable et **inactive par défaut** du module « Assistant
Consultations » : transformer certains emails reçus (boîte `nohisac3@gmail.com`)
en brouillons de chantier, après validation humaine. Cette phase ne connecte
aucune boîte Gmail, n'appelle aucune IA, ne télécharge aucune pièce jointe et
ne crée ni client ni chantier.

## Flux cible

```
Email LAURALU → AcquisitionMessage (idempotent) → WorksiteImportDraft
             → (phases futures : extraction, revue humaine, conversion en chantier)
```

## Modèles créés (`prisma/schema.prisma`)

| Modèle | Table | Rôle |
|---|---|---|
| `AcquisitionMessage` | `acquisition_messages` | Email entrant détecté par une source d'acquisition |
| `WorksiteImportDraft` | `worksite_import_drafts` | Données proposées avant validation (1–1 avec le message) |
| `AcquisitionAttachment` | `acquisition_attachments` | Métadonnées de pièce jointe (aucun téléchargement en V1) |

Enums : `AcquisitionSource` (GMAIL), `AcquisitionMessageStatus`,
`WorksiteImportDraftStatus`, `AcquisitionAttachmentStatus`,
`AcquisitionAttachmentCategory` (PLAN, PHOTO, DOCUMENT, ARCHIVE, UNSUPPORTED, UNKNOWN).

Migration : `prisma/migrations/20260718210000_add_acquisition_foundation/`
(purement additive — aucun DROP, aucune modification des tables Gmail existantes).

## Règle métier LAURALU (V1)

Un message est admissible **si et seulement si** le domaine réel de l'adresse
expéditeur, après normalisation (trim, minuscules, extraction de l'adresse
entre chevrons du header `From`), est **exactement** `lauralu.fr`.

- `CARLENE@LAURALU.FR` → admissible (normalisation)
- `user@fake-lauralu.fr` → rejeté
- `user@lauralu.fr.attacker.com` → rejeté
- `user@mail.lauralu.fr` → rejeté (sous-domaine, règle stricte V1)
- Le corps, l'objet et le nom d'affichage ne sont **jamais** consultés.
- La règle est le domaine, pas une liste figée d'adresses.

Implémentation : `normalizeSenderAddress` + `isEligibleSenderDomain` dans
`src/lib/acquisition/acquisition.service.ts` (constante `ELIGIBLE_SENDER_DOMAIN`).

## Idempotence

- Unicité composée `@@unique([companyId, source, externalMessageId])` — jamais
  d'unicité globale de l'identifiant Gmail.
- `registerIncomingMessage` : un rappel avec le même message ne crée aucun
  doublon (message, brouillon, pièce jointe) et renvoie `created: false`.
- Les courses concurrentes (P2002) sont rattrapées et résolues par relecture.
- Écritures liées (message + PJ + brouillon) dans une transaction Prisma :
  rollback complet si la création du brouillon échoue.
- Les messages non admissibles sont enregistrés en `REJECTED` (traçabilité et
  idempotence face aux re-scans) — jamais de brouillon.

## Isolation multi-tenant

- **Garantie en base (pas seulement dans le service)** : FK composites
  `(acquisitionMessageId, companyId) → acquisition_messages(id, companyId)`
  sur `worksite_import_drafts` et `acquisition_attachments`. PostgreSQL
  refuse (P2003) tout brouillon ou pièce jointe dont le `companyId` diffère
  de celui du message parent — testé en intégration.
- `companyId` obligatoire et validé en entrée de chaque fonction du service.
- Lectures uniquement via `findFirst({ where: { id, companyId } })`
  (`getImportDraftForCompany`, `getAcquisitionMessageForCompany`).
- Relations obligatoires vers `Company` avec `onDelete: Cascade`.
- Le même `externalMessageId` peut exister chez deux entreprises différentes.

## Identité des pièces jointes (`attachmentKey`)

Clé stable et déterministe par message, calculée par `buildAttachmentKey` :
`ext:<externalAttachmentId>` si fourni, sinon `part:<partId>` (partie MIME),
sinon `ord:<position>`. Jamais le seul filename. Unicité en base :
`@@unique([acquisitionMessageId, attachmentKey])`.

## Feature flag

```
PLANIFICATOR_ACQUISITION_ENABLED=false   # défaut : inactif
```

`isAcquisitionEnabled()` (service) doit être vérifié par **tout** futur point
d'entrée (connecteur Gmail, cron, page, route). Aucune page, route ou cron
n'existe dans cette phase — le module est donc doublement inactif.

## Tests

`npm run test:acquisition` (node:test via tsx — aucune dépendance ajoutée,
le projet n'avait aucune infrastructure de tests ; choix minimal documenté ici).

- Unitaires (exécutés partout) : normalisation, admissibilité (tous les cas
  imposés), validation Zod, catégorisation des PJ.
- Intégration (idempotence, isolation tenant, rollback) : nécessitent une BDD
  PostgreSQL **jetable** via `TEST_ACQUISITION_DATABASE_URL` (recommandé :
  branche Neon dédiée + `prisma db push`). Sans la variable, skip propre.

## Volontairement exclu de cette phase

- Connexion de la boîte `nohisac3@gmail.com` (le `GmailConnection` existant
  n'est pas modifié).
- Scanner/cron supplémentaire, appel Anthropic, téléchargement des PJ,
  création automatique de client ou de chantier, toute UI.

## Prochaine étape prévue

Connecteur Gmail dédié (lecture seule) + ingestion réelle derrière le feature
flag, puis extraction et écran de revue des brouillons.

---

# Connecteur Gmail — Fondation V1 (PLAN-ACQ-002A)

## Architecture retenue (minimale)

```
src/lib/acquisition/
├── connector/
│   ├── gmail-message.mapper.ts          # Canonique → RegisterIncomingMessageInput
│   ├── acquisition-gmail-sync.service.ts # Orchestration sync (provider injecté)
│   └── connector.types.ts               # CanonicalMailMessage, MailSyncResult…
├── ports/
│   ├── mail-provider.port.ts            # listMessagesPage (provider-agnostique)
│   ├── acquisition-ingestion.port.ts    # registerIncomingMessage + isEnabled
│   └── acquisition-ingestion.adapter.ts # Pont vers acquisition.service.ts
├── persistence/
│   └── acquisition-scan-cursor.repository.ts  # Seul Prisma autorisé pour le curseur
├── acquisition-feature-flag.ts
└── acquisition.service.ts               # Fondation inchangée (ingestion)
```

## Séparation Booking / Acquisition

| Module | Cron existant | Dedup | IA | Curseur |
|--------|---------------|-------|-----|---------|
| Logements (Booking) | `gmail-scan` | `processed_gmail_messages` | Oui | — |
| Assistant Consultations | *(aucun cron actif)* | `acquisition_messages` | Non | `acquisition_scan_cursors` |

Le scanner Booking **n'est pas modifié** ni réutilisé pour Acquisition.

## Modèle `AcquisitionScanCursor`

Migration : `20260718220000_add_acquisition_scan_cursor`

- Un curseur par `[companyId, source]`
- `lastHistoryId` : watermark Gmail (nullable)
- `consecutiveFailures` : compteur d'échecs globaux
- Aucun token OAuth dans cette table

## Règle de progression du curseur

Le curseur avance **par page** uniquement lorsque **tous** les messages de la
page ont un résultat persisté :

- message créé (`DRAFT_CREATED`) ;
- doublon confirmé (`created: false`) ;
- message rejeté persisté (`REJECTED`).

Si au moins un message échoue avec une erreur non persistée → statut `PARTIAL`,
curseur **non avancé**.

Échec global (provider, chargement curseur) → `FAILED`, `consecutiveFailures++`.

## Boîte Gmail par entreprise

V1 : une connexion OAuth `GmailConnection` par `companyId` (existant).
Le connecteur futur lira les tokens via un adapter — **non implémenté** dans
PLAN-ACQ-002A.

## Éléments non implémentés (PLAN-ACQ-002A)

- Appel Gmail API réel
- Téléchargement de pièces jointes
- Appel Anthropic / extraction IA
- Route cron active
- UI / menu
- CLI
- Outlook / IMAP
- Event bus
- Backoff complexe

## Prochaine phase

- Adapter Gmail réel (`GmailMailProviderAdapter`) derrière `MailProviderPort`
- Route cron **inactive** par défaut (`/api/cron/acquisition-gmail-sync`)
- Flag cron : `ACQUISITION_GMAIL_CRON_ENABLED=false`
- Réutilisation de `GmailConnection` + chiffrement existant pour OAuth

## Tests connecteur

`npm run test:acquisition` inclut :

- `gmail-message.mapper.test.ts` — mapper pur
- `acquisition-gmail-sync.service.test.ts` — sync avec mocks
- `acquisition-scan-cursor.repository.integration.test.ts` — BDD jetable

Intégration curseur : `TEST_ACQUISITION_DATABASE_URL` + `prisma migrate deploy`
(sur base jetable uniquement — jamais production).

---

# Adapter Gmail réel (PLAN-ACQ-003)

## Fichiers créés

```
src/lib/acquisition/connector/
├── gmail-mail-provider.adapter.ts   # MailProviderPort — appels Gmail réels
├── gmail-api.client.ts              # Client HTTP Gmail (mockable)
├── gmail-api.types.ts               # Types réponses API v1
├── gmail-connection.client.ts       # OAuth par tenant (gmail_connections)
├── gmail-mime-parser.ts             # Extraction métadonnées PJ (sans binaire)
├── gmail-message-sanitizer.ts       # Whitelist headers / suppression body.data
└── gmail.errors.ts                  # Erreurs typées GmailProviderError
```

## Scopes Gmail requis

Réutilise les scopes OAuth existants (`/api/auth/gmail`) :

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/userinfo.email`

Aucun nouveau scope, aucune nouvelle table OAuth.

## Préfiltre Gmail vs validation stricte (PLAN-ACQ-003-R1)

| Couche | Rôle |
|--------|------|
| Scan initial / fallback | `after:YYYY/MM/DD` uniquement — **pas de filtre expéditeur** |
| Scan incrémental | `history.list` (`historyTypes=messageAdded`) |
| `acquisition.service.ts` | Validation stricte du header `From` → domaine exact `lauralu.fr` |

Le filtre expéditeur Gmail (`from:(@lauralu.fr)`) a été **retiré en V1** car non
garanti exhaustif. Il pourra être réintroduit ultérieurement **uniquement** après
un test réel démontrant l'absence de faux négatifs sur la boîte dédiée.

Variable optionnelle : `ACQUISITION_GMAIL_LOOKBACK_DAYS` (défaut : 30 jours).

## Pagination Gmail (PLAN-ACQ-003-R1)

Contrat `MailPage` :

```typescript
{
  messages: CanonicalMailMessage[]
  nextPageToken: string | null   // curseur technique temporaire — jamais persisté
  nextHistoryId: string | null   // watermark métier — persisté après scan complet
  hasMore: boolean
  paginationMode: "history" | "lookback"
}
```

Règles :

- `nextPageToken` : pagination intra-scan (Gmail pageToken)
- `lastHistoryId` : watermark persistant — avancé **uniquement** après toutes les pages
- Page intermédiaire en échec → curseur **non avancé**
- `maxPagesPerRun` atteint → `PARTIAL` / `PAGE_LIMIT_REACHED`
- `pageSize` borne chaque appel Gmail (défaut 50, max 500) — **pas de limite globale de messages**
- Messages déjà persistés restent idempotents au prochain essai
- `history.list` : déduplication des `messageAdded` avant `messages.get`

## Curseur `historyId`

- Entrée : `cursor` = `lastHistoryId` persisté par `AcquisitionScanCursor`
- L'adapter **ne persiste jamais** le curseur — il retourne `nextHistoryId` + `nextPageToken`
- `syncAcquisitionMailForCompany` parcourt les pages jusqu'à épuisement ou limite
- Si `GMAIL_HISTORY_EXPIRED` → fallback lookback paginé, **sans écraser** le curseur immédiatement
- Nouveau `historyId` enregistré **uniquement** après succès complet de toutes les pages

## Pagination complète (PLAN-ACQ-003-R2)

Algorithme de synchronisation :

```
pageToken ← null
BOUCLE :
  page ← provider.listMessagesPage({ pageSize, pageToken, ... })
  ingérer tous les messages de la page
  si absence de nextPageToken → saveSuccessfulPage(historyId) → SUCCESS
  si pagesProcessed >= maxPagesPerRun → PARTIAL PAGE_LIMIT_REACHED
  pageToken ← nextPageToken
```

Règles :

- `pageSize` : taille de chaque page Gmail (défaut 50, max 500)
- **Aucune limite globale de messages** — interdit d'arrêter sur un quota `maxMessages`
- `maxPagesPerRun` : garde-fou défensif (défaut 100) — uniquement contre boucle anormale
- `pageToken` en mémoire uniquement — jamais persisté en base
- `lastHistoryId` avancé uniquement après la dernière page réussie


Par message : headers whitelist (`From`, `Subject`, `Date`, `Message-ID`), labels,
snippet, métadonnées PJ. Sanitizer explicite : **aucun** `body.data`, payload brut
ni header sensible dans le modèle canonique, logs ou erreurs.

Fichier : `gmail-message-sanitizer.ts`

## Erreurs typées (`GmailProviderError`)

| Code | Retryable | Portée |
|------|-----------|--------|
| `GMAIL_NOT_CONNECTED` | Non | Globale |
| `GMAIL_TOKEN_REFRESH_FAILED` | Parfois (5xx/429) | Globale |
| `GMAIL_UNAUTHORIZED` | Non | Globale |
| `GMAIL_RATE_LIMITED` | Oui | Globale |
| `GMAIL_HISTORY_EXPIRED` | Oui (fallback) | Globale |
| `GMAIL_UNAVAILABLE` | Oui (5xx) | Globale |
| `GMAIL_MESSAGE_PARSE_ERROR` | Non | Message (page partielle) |

Aucun token, refresh token ou secret dans les messages d'erreur.

## Feature flag

Inchangé : `PLANIFICATOR_ACQUISITION_ENABLED=false` par défaut.
L'adapter est utilisable en injection ; aucun cron actif dans PLAN-ACQ-003
(reporter route `/api/cron/acquisition-gmail-sync` à PLAN-ACQ-003B).

## Tests ajoutés

- `gmail.errors.test.ts`
- `gmail-mime-parser.test.ts`
- `gmail-mail-provider.adapter.test.ts` (client Gmail mocké — aucun appel réel)
- `gmail-message-sanitizer.test.ts`

## Volontairement exclus (PLAN-ACQ-003)

- Route cron active
- Téléchargement binaire des PJ
- Appels Anthropic / IA
- UI, création chantier automatique
- Modification du scanner Booking `gmail-scan`
- Test d'intégration contre boîte Gmail réelle (infrastructure absente)
