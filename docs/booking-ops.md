# Booking ops — flags serveur (gmail-scan)

Flags applicatifs du cron Booking `/api/cron/gmail-scan`. Aucun secret.

| Variable | Activation | Défaut | Effet |
|----------|------------|--------|-------|
| `BOOKING_GMAIL_SCAN_ENABLED` | exactement `"true"` | OFF | Cron skippe le scan (`DISABLED`) si non activé |
| `BOOKING_SCAN_PENDING_ONLY` | exactement `"true"` | OFF | Voir ci-dessous |
| `BOOKING_GMAIL_MAX_ATTEMPTS` | entier 1–20 | `5` | Plafond de tentatives lifecycle (retryables, dont intent ambigu) |

## `BOOKING_SCAN_PENDING_ONLY`

| Mode | Comportement |
|------|----------------|
| **OFF** (absent ou valeur ≠ `"true"`) | Historique : `createOrGetBookingScanResult` peut créer un `Accommodation` si équipe matchée + admin + adresse + dates |
| **ON** (`"true"`) | Aucun `Accommodation` automatique : create / enrich `PendingAccommodation` uniquement ; `resultType` = `PENDING_ACCOMMODATION` |

Périmètre : uniquement le chemin cron Gmail via `createOrGetBookingScanResult`.

Hors périmètre : routes N8N (`/api/booking/reservations`), Booking agent (`/api/booking/agent`), OAuth, cleanup.

Ne pas exposer ces variables au client.

## Compteurs cron `gmail-scan` (intent PARSER-003)

| Compteur | Signification |
|----------|----------------|
| `confirmationCount` | Emails classifiés **CONFIRMATION** (intent), **pas** le nombre de pendings/logements créés |
| `hostMessageIgnoredCount` | Messages établissement ignorés définitivement |
| `receiptIgnoredCount` | Reçus / factures ignorés définitivement |
| `cancellationIgnoredCount` | Annulations Gmail ignorées (N8N/Agent inchangés) |
| `otherIgnoredCount` | Autres hors-confirmation (promo, identité, etc.) |
| `ambiguousCount` | Passages classifiés AMBIGU (chaque tentative compte) |

## Table lifecycle Gmail Booking

Modèle Prisma : `ProcessedGmailMessage`.
Table physique PostgreSQL (Prisma `@@map`) : **`processed_gmail_messages`**.
Colonnes : camelCase entre guillemets (`"companyId"`, `"messageId"`, `"errorCode"`, …).
Ne jamais cibler `"ProcessedGmailMessage"` en SQL brut.

## `BOOKING_EMAIL_INTENT_AMBIGUOUS` (AMBIGU)

### Signification

Le classifieur n’a ni prouvé une confirmation initiale, ni un hors-périmètre fiable (host / reçu / annulation / autre).
**Aucun** appel Anthropic, **aucun** `PendingAccommodation`, **aucune** `Accommodation` sur ce chemin.

### Retry borné

1. Tentatives `1 … N-1` (`N = BOOKING_GMAIL_MAX_ATTEMPTS`, défaut 5) : statut `RETRYABLE_FAILURE`, code `BOOKING_EMAIL_INTENT_AMBIGUOUS`, `nextRetryAt` via backoff lifecycle.
2. Tentative `N` : `PERMANENTLY_IGNORED`, code diagnostique **conservé** `BOOKING_EMAIL_INTENT_AMBIGUOUS`.
3. Claims suivants : `SKIP` / `PERMANENTLY_IGNORED` — pas de boucle infinie.

Hors-confirmation **prouvé** (host, reçu, annulation, autre) reste en **ignore permanent immédiat** (codes `IGNORED_BOOKING_*`).

### Inspecter les occurrences

```sql
-- Ambigu en attente de retry
SELECT "companyId", "messageId", "attemptCount", "nextRetryAt", "errorCode", "updatedAt"
FROM processed_gmail_messages
WHERE "errorCode" = 'BOOKING_EMAIL_INTENT_AMBIGUOUS'
  AND "status" = 'RETRYABLE_FAILURE'
ORDER BY "updatedAt" DESC
LIMIT 100;

-- Ambigu définitivement ignorés (plafond atteint)
SELECT "companyId", "messageId", "attemptCount", "errorCode", "errorMessage", "updatedAt"
FROM processed_gmail_messages
WHERE "errorCode" = 'BOOKING_EMAIL_INTENT_AMBIGUOUS'
  AND "status" = 'PERMANENTLY_IGNORED'
ORDER BY "updatedAt" DESC
LIMIT 100;
```

Surveiller aussi `ambiguousCount` dans la réponse JSON / logs du cron `[CRON gmail-scan]`.

### Reprise contrôlée après amélioration du classifieur (AMBIGU)

Aucune route HTTP de reset. Pas de `deleteMany({})`.

Procédure scoped et auditée (ops / admin DB uniquement) :

1. Améliorer et déployer le classifieur.
2. Lister les `messageId` concernés (requêtes ci-dessus), **filtrés par `companyId`**.
3. Pour chaque ligne à retraiter (échantillon ou liste nominative), exécuter d’abord le **dry-run SELECT** avec **exactement les mêmes prédicats** que l’UPDATE, et vérifier **exactement une ligne** :

```sql
-- DRY-RUN : mêmes prédicats que l’UPDATE scoped (doit retourner exactement 1 ligne)
SELECT "companyId", "messageId", "status", "errorCode", "attemptCount", "errorMessage", "updatedAt"
FROM processed_gmail_messages
WHERE "companyId" = '<COMPANY_ID>'
  AND "messageId" = '<GMAIL_MESSAGE_ID>'
  AND "errorCode" = 'BOOKING_EMAIL_INTENT_AMBIGUOUS'
  AND "status" = 'PERMANENTLY_IGNORED';
```

4. Si et seulement si le dry-run renvoie **une** ligne, appliquer l’UPDATE :

```sql
-- UPDATE scoped : prédicats identiques au dry-run
UPDATE processed_gmail_messages
SET
  "status" = 'RETRYABLE_FAILURE',
  "nextRetryAt" = NOW(),
  "attemptCount" = 0,
  "errorCode" = 'BOOKING_EMAIL_INTENT_AMBIGUOUS',
  "errorMessage" = 'reset ops après amélioration classifieur',
  "resultType" = NULL,
  "updatedAt" = NOW()
WHERE "companyId" = '<COMPANY_ID>'
  AND "messageId" = '<GMAIL_MESSAGE_ID>'
  AND "errorCode" = 'BOOKING_EMAIL_INTENT_AMBIGUOUS'
  AND "status" = 'PERMANENTLY_IGNORED';
```

5. Vérification après UPDATE (mêmes clés, statut attendu) :

```sql
-- POST-CHECK : la ligne doit être RETRYABLE_FAILURE, code ambigu conservé
SELECT "companyId", "messageId", "status", "errorCode", "attemptCount", "nextRetryAt", "updatedAt"
FROM processed_gmail_messages
WHERE "companyId" = '<COMPANY_ID>'
  AND "messageId" = '<GMAIL_MESSAGE_ID>'
  AND "errorCode" = 'BOOKING_EMAIL_INTENT_AMBIGUOUS'
  AND "status" = 'RETRYABLE_FAILURE';
```

6. Laisser le prochain cron `claimForProcessing` reprendre (`attemptCount` repartira à 1 au reclaim).
7. Journaliser l’opération (qui / quand / companyId / messageId / motif).

Ne jamais resetter en masse sans liste nominative et validation.
Ne jamais exécuter l’UPDATE si le dry-run ne retourne pas exactement une ligne.

## `IGNORED_BOOKING_HOST_MESSAGE` (HOST)

### Signification

Email classifié `MESSAGE_ETABLISSEMENT` (message établissement/hôte, hors confirmation initiale).
Ignore permanent immédiat. Claims suivants : `SKIP` / `PERMANENTLY_IGNORED`.

### Inspecter (lecture seule)

```sql
SELECT "companyId", "messageId", "status", "errorCode", "attemptCount", "updatedAt"
FROM processed_gmail_messages
WHERE "errorCode" = 'IGNORED_BOOKING_HOST_MESSAGE'
  AND "status" = 'PERMANENTLY_IGNORED'
ORDER BY "updatedAt" DESC
LIMIT 100;
```

### Reprise contrôlée après correction faux positif HOST

**Prérequis obligatoires :**

1. Classifieur corrigé **déjà déployé**.
2. `companyId` exact.
3. **Gmail API `messageId` exact** (≠ référence Booking métier).
4. Dry-run retournant **exactement une** ligne.
5. **Aucun** reset global ; **aucun** UPDATE de plusieurs lignes HOST en bloc.
6. Une reprise = une ligne nominative.

```sql
-- DRY-RUN (1 ligne attendue) — ne pas UPDATE tant que messageId Gmail non identifié
SELECT "companyId", "messageId", "status", "errorCode", "attemptCount", "errorMessage", "updatedAt"
FROM processed_gmail_messages
WHERE "companyId" = '<COMPANY_ID>'
  AND "messageId" = '<GMAIL_MESSAGE_ID>'
  AND "errorCode" = 'IGNORED_BOOKING_HOST_MESSAGE'
  AND "status" = 'PERMANENTLY_IGNORED';
```

L’UPDATE de reprise (même prédicats) n’est **pas** exécuté dans le lot de correction code ; il reste une opération ops manuelle post-déploiement, ligne par ligne, après dry-run = 1.
