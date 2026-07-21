# PLAN-ACQ-OPS-002 — Scheduling Acquisition (externe / Hobby)

| Champ | Valeur |
|-------|--------|
| **Version** | 1.1.0 |
| **Lot** | PLAN-ACQ-OPS-002 |
| **Config Vercel** | `vercel.json` — crons Booking/chantiers uniquement |
| **Hors périmètre** | Workers content/extraction ; orchestration ; nouveaux flags ; Booking ; Prisma ; mise en place du scheduler externe |

## Objectif

Préparer les **points d’entrée HTTP** des crons Acquisition (`maxDuration`, auth `CRON_SECRET`, gates OPS-001) sans les déclarer dans Vercel Cron.

**Contrainte plan** : le projet reste sur **Vercel Hobby**. Hobby refuse toute expression cron exécutée plus d’une fois par jour. Les fréquences Acquisition requises (sub-quotidiennes) **ne sont pas dégradées** en quotidiens : elles seront assurées **hors Vercel**.

L’exécution métier reste **gated par les feature flags** (OPS-001) : sans flags ON, chaque run retourne `SKIPPED` (no-op contrôlé).

## Décision d’architecture

| Choix | Détail |
|-------|--------|
| Application | Reste sur **Vercel Hobby** (pas d’achat Pro dans ce lot) |
| `vercel.json` | Conserve **uniquement** les crons compatibles existants Booking/chantiers |
| Routes Acquisition | Existent, sécurisées par `CRON_SECRET` ; **non** enregistrées comme Vercel Cron |
| Scheduling Acquisition | **Externe** (cible privilégiée : Raspberry Pi / ordonnanceur contrôlé) — **non configuré dans ce lot** |

Présence des routes ≠ activation effective. **Aucun cron Acquisition n’est actif** tant que le scheduler externe n’est pas configuré et n’appelle pas les endpoints.

## Fréquences cibles (UTC) — scheduler externe

| Path | Schedule cible | Fréquence |
|------|----------------|-----------|
| `/api/cron/acquisition-gmail-sync` | `*/15 * * * *` | Toutes les 15 minutes |
| `/api/cron/acquisition-attachment-download` | `5,20,35,50 * * * *` | Toutes les 15 minutes, décalé de +5 min |
| `/api/cron/acquisition-attachment-recovery` | `40 * * * *` | Toutes les heures à :40 |

Ces expressions restent la **cible opérationnelle** ; elles ne figurent **pas** dans `vercel.json`.

### Schedules Vercel inchangés (Hobby-compatibles)

| Path | Schedule |
|------|----------|
| `/api/cron/chantiers` | `0 5 * * *` |
| `/api/cron/gmail-scan` | `0 8 * * *` |

## Justification

1. **Sync Gmail (15 min)** — latence acceptable pour consultations LAURALU ; limite la charge History API / quotas tout en restant « temps opérationnel ».
2. **Download (+5 min)** — laisse le run sync précédent créer des `DISCOVERED` avant le drain PJ ; évite une collision systématique minute-à-minute avec le sync.
3. **Recovery (horaire :40)** — reclaim / retry moins urgents ; créneau hors des ticks sync/download exacts.
4. **Isolation Booking** — pas de modification des crons logements ; pipelines distincts (Acquisition ≠ `gmail-scan`).
5. **Hobby** — Vercel ne peut pas planifier ces fréquences ; externaliser plutôt que dégrader ou upgrader Pro dans ce lot.

## Dépendances

| Prérequis | Rôle |
|-----------|------|
| `CRON_SECRET` (env déploiement) | Auth Bearer obligatoire sur chaque route |
| Scheduler externe (futur) | Invoque les routes aux fréquences cibles ; **pas encore déployé** |
| Flags OPS-001 | Master + capacités / crons ON pour exécution réelle |
| Connexion Gmail saine (`GmailConnection`) | Sync uniquement |

Sans flags ON : un appel authentifié aux routes → `200` + `status: "SKIPPED"` + `skipReason` (`CRON_DISABLED` / master / capacité selon code déployé).

## Budget d’exécution

| Route | `maxDuration` (route) | Budget applicatif (défaut) |
|-------|----------------------|----------------------------|
| Gmail sync | 300 s | Bornes internes du driver (pas de plafond temps global dédié) |
| Attachment download | 300 s | `ACQUISITION_ATTACHMENT_CRON_MAX_DURATION_MS` = **240000** ms |
| Attachment recovery | 300 s | `ACQUISITION_ATTACHMENT_RECOVERY_MAX_DURATION_MS` = **240000** ms |

Si le budget applicatif est atteint : statut `PARTIAL` + reprise au run suivant (pas d’annulation mid-attachment une fois démarré).

Plafonds batch (download / recovery) : `MAX_PER_COMPANY`, `MAX_PER_RUN`, `MAX_COMPANIES_PER_RUN` — voir flags dédiés.

## Stratégie de reprise

| Situation | Comportement |
|-----------|--------------|
| Flag cron / master / capacité OFF | `SKIPPED` — zéro mutation |
| Run `PARTIAL` (budget / plafonds) | Travail restant repris au tick suivant (FIFO `DISCOVERED`, recovery reclaim/retry) |
| Run `FAILED` (listing, erreur structurée) | Tick suivant réessaie ; pas de curseur avancé si sync n’a pas réussi (comportement service existant) |
| Timeout plateforme | Claims `PENDING_DOWNLOAD` récupérés par **recovery** (TTL reclaim) |
| Kill-switch master | Coupe sync / download / recovery (selon gates déployées OPS-001) |

## Auth & contrat HTTP

- Header : `Authorization: Bearer $CRON_SECRET`
- Absent / invalide → **401** `{ "error": "Unauthorized" }`
- Succès / skip / partiel → **200** + JSON structuré (`status`, stats, `skipReason` si applicable)
- Pas d’exposition de secrets, tokens Gmail, URLs signées, stack Prisma

## Activation progressive (hors code de ce lot)

1. Déployer les routes + `maxDuration` (sans cron Vercel Acquisition).
2. Configurer le scheduler externe (Raspberry Pi / équivalent) avec les fréquences cibles — **étape non réalisée ici**.
3. Smoke appel manuel / scheduler → `SKIPPED` tant que flags OFF.
4. Activer flags selon matrice OPS-001 / runbook OPS-007.
5. Observer un run sync puis download avant d’élargir.

## Tests

- `tests/acquisition/acquisition-ops-002-scheduling.test.ts` — `vercel.json` sans Acquisition ; routes + `maxDuration` ; doc Hobby / fréquences externes
- Routes existantes : 401 / SKIPPED (scripts `test:acquisition:scheduling` / `npm test`)
