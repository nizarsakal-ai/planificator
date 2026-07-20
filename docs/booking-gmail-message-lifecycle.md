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

## Idempotence

- Clé unique BDD : `(companyId, messageId)`.
- Claim : `create` PROCESSING ou reprise conditionnelle (`updateMany`).
- Succès : transaction Prisma regroupant création/récupération du résultat **et** passage à `SUCCEEDED`.
- Pending : réutilisation si `PendingAccommodation` existe déjà pour `(companyId, gmailMessageId)`.
- Accommodation : réutilisation si même company + team + address + startDate + endDate.

## Retry

| Paramètre | Défaut | Env |
|-----------|--------|-----|
| Max tentatives | 5 | `BOOKING_GMAIL_MAX_ATTEMPTS` (1–20) |
| Stale PROCESSING | 15 min | `BOOKING_GMAIL_PROCESSING_STALE_MS` |
| Backoff | 5 min × 2^(attempt-1), cap 6 h | — |

## Erreurs

**Retraitables** : réseau Gmail, provider temporaire, timeout, DB temporaire, inconnues par défaut.

**Permanentes** : corps vide confirmé, aucune donnée Booking utile, date avant cutoff métier documenté (17/06/2026), max tentatives.

Les messages d’erreur sont tronqués et nettoyés (pas de tokens, pas de corps email).

## Lignes historiques

Toute ligne existante avant cette migration est traitée comme **`SUCCEEDED`** (déjà consommée).  
Elle **n’est pas** retraitée automatiquement — certaines ont déjà produit un logement ou un pending.

## Diagnostic d’un message bloqué

1. Lire `processed_gmail_messages` pour `(companyId, messageId)`.
2. Inspecter `status`, `attemptCount`, `errorCode`, `nextRetryAt`, `resultType`, `resultEntityId`.
3. Si `RETRYABLE_FAILURE` et due : attendre le prochain cron ou forcer `nextRetryAt = now()` (ops).
4. Si `PROCESSING` stale : le prochain cron reclaim.
5. Si `PERMANENTLY_IGNORED` : analyser `errorCode` ; retraitement manuel hors bande seulement.
6. Ne pas utiliser `gmail-reset-test` en production (wipe global Booking).

## Fichiers

- `src/lib/booking/gmail-message-lifecycle.ts`
- `src/lib/booking/booking-gmail-errors.ts`
- `src/lib/booking/booking-scan-result.ts`
- `src/app/api/cron/gmail-scan/route.ts`
- Migration `20260720220000_booking_gmail_message_lifecycle`
