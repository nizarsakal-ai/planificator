# Domaine — Booking (logements depuis Gmail)

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ**. Invariants normatifs : [`docs/booking/BOOKING-INVARIANTS.md`](../../docs/booking/BOOKING-INVARIANTS.md) (C-BOOK-001) — **à lire, non dupliqués ici**.

| Élément | Constat |
|---------|---------|
| Modèles | `Accommodation`, `PendingAccommodation`, `GmailConnection`, `ProcessedGmailMessage` ; enums `BookingGmailMessageStatus` et `BookingGmailResultType` (cycle de vie des messages Gmail) |
| Code | `src/lib/booking/` ; API `/api/booking/reservations`, `/api/booking/agent` ; cron `/api/cron/gmail-scan` (08:00) |
| Flag | `BOOKING_GMAIL_SCAN_ENABLED` |
| Migrations | `booking_gmail_message_lifecycle`, `booking_pending_gmail_unique`, `booking_accommodation_gmail_source`, `booking_identity_tenant_isolation` |
| Tests | `npm run test:booking`, `test:booking:unit`, `test:booking:identity:pg` (PostgreSQL) ; preuve E2E : `docs/booking-e2e-proof-tests.md` |
| Ops | `docs/booking-ops.md` |

## Règles clés (résumé des invariants)

Un message n'est « réussi » qu'après persistance cohérente du résultat ; un retry ne crée jamais de doublon ; au plus un pending et une accommodation par `(entreprise, message Gmail)` ; aucune suppression automatique de données ; Booking ≠ Acquisition (suivis distincts).
