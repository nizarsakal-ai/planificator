# Booking Gmail — cycle de vie des messages (PLAN-BOOKING-RELIABILITY-001)

| Champ | Valeur |
|-------|--------|
| **Statut** | Normatif ops Booking — module **non** déclaré terminé |
| **Périmètre** | Table `processed_gmail_messages` + cron `/api/cron/gmail-scan` |
| **Hors périmètre** | Acquisition, prompt IA, Zod extraction, UI, pagination |

## Machine d’état

```
(absent)
    → claim → PROCESSING
         ├─ succès TX résultat → SUCCEEDED
         ├─ erreur permanente → PERMANENTLY_IGNORED
         └─ erreur temporaire → RETRYABLE_FAILURE
                └─ (nextRetryAt écoulé, attemptCount < max) → PROCESSING …
                       └─ max attempts → PERMANENTLY_IGNORED

PROCESSING abandonné (lastAttemptAt trop vieux) → reclaim → PROCESSING (attempt++)
```

| Statut | Retraitement auto |
|--------|-------------------|
| `SUCCEEDED` | Non |
| `PERMANENTLY_IGNORED` | Non |
| `RETRYABLE_FAILURE` | Oui si `nextRetryAt <= now` et tentatives &lt; max |
| `PROCESSING` | Oui si stale (TTL défaut 15 min) |

## Idempotence et sémantique des identifiants

| Identifiant | Rôle |
|-------------|------|
| `ProcessedGmailMessage (companyId, messageId)` | Claim / cycle de vie |
| `PendingAccommodation (companyId, gmailMessageId)` | Idempotence pending |
| `Accommodation (companyId, gmailSourceMessageId)` | Clé technique Gmail (nullable hors Gmail) |
| `Accommodation.bookingReference` | **Uniquement** référence métier Booking.com |

- Claim : `create` PROCESSING ou reprise conditionnelle (`updateMany`).
- Succès : transaction Prisma = création/récupération du résultat **et** `SUCCEEDED`.
- Pending unique : migration **Option A** — échoue s’il existe des doublons ; **aucun DELETE automatique**.
- `bookingReference` n’est jamais rempli avec un id Gmail technique.

### Doublons pending — diagnostic (préflight lecture seule)

```sql
SELECT "companyId",
       "gmailMessageId",
       COUNT(*) AS n,
       array_agg(id ORDER BY "createdAt") AS ids,
       array_agg(status::text ORDER BY "createdAt") AS statuses,
       array_agg("accommodationId" ORDER BY "createdAt") AS accommodation_ids
FROM "pending_accommodations"
WHERE "gmailMessageId" IS NOT NULL
GROUP BY "companyId", "gmailMessageId"
HAVING COUNT(*) > 1;
```

| Résultat | Action |
|----------|--------|
| Vide | Migration autorisée |
| ≥ 1 ligne | **Déploiement interdit** — audit et consolidation manuelle obligatoire |

Consolider manuellement (préserver `CONFIRMED` / `accommodationId` non null, données utilisateur), puis `prisma migrate deploy`.

## Claim, retry et PROCESSING obsolète

- **Claim** : `INSERT` en `PROCESSING` sous unique `(companyId, messageId)` ; conflit `P2002` → lecture + `updateMany` conditionnel (retry due / stale).
- **Retry** : `RETRYABLE_FAILURE` + `nextRetryAt` (backoff 5 min × 2^(n-1), cap 6 h) ; max tentatives → `PERMANENTLY_IGNORED`.
- **Stale** : `PROCESSING` avec `lastAttemptAt` plus vieux que le TTL (défaut 15 min) → reclaim atomique (`updateMany` + `attemptCount`).

| Paramètre | Défaut | Env |
|-----------|--------|-----|
| Max tentatives | 5 | `BOOKING_GMAIL_MAX_ATTEMPTS` (1–20) |
| Stale PROCESSING | 15 min | `BOOKING_GMAIL_PROCESSING_STALE_MS` |
| Backoff | 5 min × 2^(attempt-1), cap 6 h | — |

## Déploiement

1. Exécuter le préflight SQL ci-dessus en **lecture seule** sur la cible.
2. Si non vide : stopper ; consolider ; rejouer le préflight.
3. `npx prisma migrate deploy`
4. Redéployer l’application (cron `/api/cron/gmail-scan`).
5. Vérifier logs cron (`scanned` / `retryable` / `permanent` / `detected`).

## Incident et rollback logique

- **Message bloqué** : section diagnostic ci-dessus ; ne pas wipe via `gmail-reset-test` en prod.
- **Migration échouée sur doublons** : aucune donnée supprimée ; corriger les doublons ; relancer migrate.
- **Rollback applicatif** : redeployer le code précédent ; laisser les colonnes/enums/index en place (additifs). Ne pas `DROP` en production.
- **Rollback schéma destructif** : interdit dans ce lot.

## Erreurs

**Retraitables** : réseau Gmail, provider temporaire, timeout, DB temporaire, inconnues par défaut.

**Permanentes** : corps vide confirmé, aucune donnée Booking utile, date avant cutoff métier documenté (17/06/2026), max tentatives.

## Lignes historiques

Toute ligne `ProcessedGmailMessage` existante avant la migration lifecycle → **`SUCCEEDED`** (déjà consommée).

## Bruit Prisma format (PR future)

Le commit `34c80b3` contient ~650 lignes de reformat `prisma format` sur `schema.prisma` (alignement commentaires). Non réécrit sans squash d’historique — documenter en revue PR.

## Diagnostic d’un message bloqué

1. Lire `processed_gmail_messages` pour `(companyId, messageId)`.
2. Inspecter `status`, `attemptCount`, `errorCode`, `nextRetryAt`, `resultType`, `resultEntityId`.
3. Si `RETRYABLE_FAILURE` et due : prochain cron ou `nextRetryAt = now()` (ops).
4. Si `PROCESSING` stale : reclaim au prochain cron.
5. Si `PERMANENTLY_IGNORED` : analyser `errorCode`.
6. Ne pas utiliser `gmail-reset-test` en production.

## Migrations

- `20260720220000_booking_gmail_message_lifecycle` — cycle de vie (additif)
- `20260720224500_booking_pending_gmail_unique` — unique pending, **fail si doublons**
- `20260720230000_booking_accommodation_gmail_source` — `gmailSourceMessageId`
