# Intégrations

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (noms de variables d'environnement relevés dans le code ; **aucune valeur lue**). Spécifications détaillées existantes : `docs/integration-platform-001*.md`, `docs/acquisition-*.md`, `docs/booking-ops.md`.

| Service | Usage constaté | Variables (noms) | Documentation existante |
|---------|----------------|------------------|-------------------------|
| Gmail (OAuth Google) | Acquisition d'e-mails (consultations), booking | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_OAUTH_REDIRECT_URI`, `GMAIL_TOKEN_ENCRYPTION_KEY` | `docs/assistant-consultations-fondation.md`, `docs/booking-ops.md` |
| Anthropic | Extraction IA des e-mails (flag-gated) | `ANTHROPIC_API_KEY`, `ACQUISITION_EXTRACTION_*` | `docs/acquisition-ops-004-extraction-cron.md` |
| Cloudinary | Stockage des pièces jointes | `CLOUDINARY_*`, `ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX` | `docs/acquisition-ops-*.md` |
| Resend | E-mails transactionnels | `RESEND_API_KEY`, `FROM_EMAIL` | — |
| Vercel Cron | Orchestration planifiée | `CRON_SECRET` | `docs/acquisition-ops-002-scheduling.md` |

## Règles

1. Tout secret de connecteur est stocké chiffré (jetons Gmail : AES-256-GCM, `src/lib/encryption.ts`, clé `GMAIL_TOKEN_ENCRYPTION_KEY`) ; la plateforme d'intégration interdit les secrets en clair (`IntegrationConnection`).
2. Les capacités externes sont **inactives par défaut** et activées par flags (`PLANIFICATOR_ACQUISITION_ENABLED` et la famille `ACQUISITION_*_ENABLED`, `BOOKING_GMAIL_SCAN_ENABLED`). Runbook : `docs/RB-PLAN-ACQ-001-activation-flags.md`.
3. Les journaux ne contiennent jamais de contenu d'e-mail brut ni de secret (observabilité : `tests/integration/observability/redaction.test.ts`).

## À AUDITER

- Cartographie complète des flags et de leur valeur par environnement (non lue volontairement).
- Quotas et coûts des services externes.
