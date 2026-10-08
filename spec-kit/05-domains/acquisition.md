# Domaine — Acquisition

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour l'inventaire (schéma, `src/lib/acquisition/`, docs existantes, `package.json`). Le domaine est **le plus documenté du dépôt** : ce fichier **renvoie** aux specs existantes, il ne les remplace pas.

## Fonction

Pipeline « e-mail entrant (Gmail) → `AcquisitionMessage` (idempotent) → contenu → extraction (IA, flag-gated) → `WorksiteImportDraft` → revue → conversion en chantier ». **Inactif par défaut** (`PLANIFICATOR_ACQUISITION_ENABLED` et famille `ACQUISITION_*_ENABLED`).

## Sous-systèmes (`src/lib/acquisition/`)

`connector` (sync Gmail), `content` (contenu normalisé), `attachments`, `extraction`, `detection` (consultations), `matching`, `review`, `conversion`, `orchestrator` + `ops` (cron, bail, fencing), `persistence`, `policy`, `ports`, `access`, `admin`, `capabilities`, registre de partenaires (`partner-*`).

## Données

`AcquisitionMessage`, `AcquisitionMessageContent`, `AcquisitionContentFetchState`, `WorksiteImportDraft`, `AcquisitionDecisionJournal` (clé d'idempotence), `AcquisitionAttachment` (+ journal d'accès), `AcquisitionScanCursor`, `AcquisitionPartner` (+ domaines, e-mails), `AcquisitionOrchestratorLease`, `AcquisitionGmailConnection` (multi-connexions Gmail par entreprise).

## Exploitation

- Cron production : `/api/cron/acquisition-orchestrator`, toutes les heures (`vercel.json`). Autres crons d'acquisition présents dans `src/app/api/cron/` (noms exacts des dossiers) : `acquisition-gmail-sync`, `acquisition-content-fetch`, `acquisition-extraction`, `acquisition-attachment-download`, `acquisition-attachment-recovery`.
- **Doc existante divergente** : le runbook `docs/acquisition-ops-v2-staging-activation.md` (l. 88) dit l'orchestrateur « hors `vercel.json`, intervalle 5–15 min » et le commentaire de `src/app/api/cron/acquisition-orchestrator/route.ts` (l. 5) « non déclaré dans vercel.json (scheduler externe) » ; `vercel.json` le programme **toutes les heures** (commit `e619b7e`). À mettre à jour par un lot de doc dédié.
- Docs : `docs/acquisition-ops-*.md`, `docs/RB-PLAN-ACQ-001-activation-flags.md`, `docs/acquisition-partner-registry-cutover.md`, `docs/plan-acq-012-*.spec.md`, `docs/assistant-consultations-fondation.md`.
- Tests : `npm run test:acquisition` (très large liste de fichiers), `test:acquisition:flags`, `test:acquisition:conversion:pg` (PostgreSQL).

## Invariants à respecter

Idempotence par message ; fraîcheur de la source revalidée avant mutation AUTO ; autorité d'annulation ; preuve de détection requise avant extraction AUTO (commits `76a9145`, `5d85ea4`). Détail dans les specs `docs/plan-acq-012-*`.

## À AUDITER

État RELEASED/CLOSED de chaque lot PLAN-ACQ-012 ; cohérence entre la liste de tests de `package.json` et le contenu réel de `tests/acquisition/` (liste codée en dur ; voir `06-quality/testing-strategy.md` pour le chiffre global).
