# Booking ops — flags serveur (gmail-scan)

Flags applicatifs du cron Booking `/api/cron/gmail-scan`. Aucun secret.

| Variable | Activation | Défaut | Effet |
|----------|------------|--------|-------|
| `BOOKING_GMAIL_SCAN_ENABLED` | exactement `"true"` | OFF | Cron skippe le scan (`DISABLED`) si non activé |
| `BOOKING_SCAN_PENDING_ONLY` | exactement `"true"` | OFF | Voir ci-dessous |

## `BOOKING_SCAN_PENDING_ONLY`

| Mode | Comportement |
|------|----------------|
| **OFF** (absent ou valeur ≠ `"true"`) | Historique : `createOrGetBookingScanResult` peut créer un `Accommodation` si équipe matchée + admin + adresse + dates |
| **ON** (`"true"`) | Aucun `Accommodation` automatique : create / enrich `PendingAccommodation` uniquement ; `resultType` = `PENDING_ACCOMMODATION` |

Périmètre : uniquement le chemin cron Gmail via `createOrGetBookingScanResult`.

Hors périmètre : routes N8N (`/api/booking/reservations`), Booking agent (`/api/booking/agent`), OAuth, cleanup.

Ne pas exposer ces variables au client.
