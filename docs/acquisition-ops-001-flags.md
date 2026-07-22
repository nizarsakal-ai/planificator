# PLAN-ACQ-OPS-001 — Matrice des feature flags Acquisition

| Champ | Valeur |
|-------|--------|
| **Version** | 1.1.0 |
| **SPEC** | PLAN-ACQ-OPS-001-SPEC |
| **Module code** | `src/lib/acquisition/acquisition-flag-matrix.ts` |
| **Hors périmètre** | Scheduling `vercel.json` (OPS-002) ; runbook complet `RB-PLAN-ACQ-001-activation-flags.md` (OPS-007) |

## Correspondance flags ↔ helpers

| Variable env | Helper brut | Notes |
|--------------|-------------|-------|
| `PLANIFICATOR_ACQUISITION_ENABLED` | `isAcquisitionMasterEnabled` / `isAcquisitionEnabled` | Kill-switch master |
| `ACQUISITION_GMAIL_CRON_ENABLED` | `isAcquisitionGmailCronEnabled` | |
| `ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED` | `isAcquisitionAttachmentDownloadEnabled` | Capacité download |
| `ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED` | `isAcquisitionAttachmentDownloadCronEnabled` | |
| `ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED` | `isAcquisitionAttachmentRecoveryCronEnabled` | |
| `ACQUISITION_ATTACHMENT_ACCESS_ENABLED` | `isAcquisitionAttachmentAccessEnabled` | N’ôte jamais AuthZ |
| `ACQUISITION_CONTENT_FETCH_ENABLED` | `isAcquisitionContentFetchEnabled` | |
| `ACQUISITION_CONTENT_CRON_ENABLED` | `isAcquisitionContentCronEnabled` | OPS-003 — automatisation seule |
| `ACQUISITION_EXTRACTION_ENABLED` | `isAcquisitionExtractionEnabled` | |
| `ACQUISITION_EXTRACTION_CRON_ENABLED` | `isAcquisitionExtractionCronEnabled` | OPS-004 — automatisation seule |
| `ACQUISITION_EXTRACTION_PROVIDER` | `getExtractionProviderId` | Défaut `deterministic` |
| `ACQUISITION_CONVERSION_ENABLED` | `isAcquisitionConversionEnabled` | Flag **brut** conversion |

**Conversion fully enabled** = `isAcquisitionConversionFullyEnabled()` = master **ET** flag conversion brut.
Ne pas confondre le flag env seul avec l’état fully enabled.

Convention booléenne : uniquement `=== "true"` (sensible à la casse).

## Gates cron (skipReason)

| Ordre | Code |
|-------|------|
| 1 | `CRON_DISABLED` |
| 2 | `MASTER_DISABLED` |
| 3 | `DOWNLOAD_CAPABILITY_DISABLED` (download/recovery) ou `CONTENT_FETCH_DISABLED` (content / extraction cron) |
| 4 | `EXTRACTION_DISABLED` (extraction cron uniquement) |

Auth HTTP Bearer `CRON_SECRET` est **avant** ces gates (handlers).

Gates extraction cron (OPS-004) : cron → master → content → extraction.
## Combinaisons invalides (matrice)

`validateAcquisitionFlagMatrix()` détecte les combos incohérentes (`INV_*`) **sans** crasher le process.
L’enforcement runtime reste aux gates des services/crons.

## Mapping outcomes (compat — ne pas unifier dans ce lot)

| Concept SPEC | Code dépôt | Couche |
|--------------|------------|--------|
| CRON_DISABLED | `CRON_DISABLED` | Cron run |
| MASTER_DISABLED | `MASTER_DISABLED` | Cron run (gate global) |
| FEATURE_DISABLED | `FEATURE_DISABLED` | Sync **tenant** historique (`MailSyncResult`) quand master OFF au service |
| DOWNLOAD_CAPABILITY_DISABLED | `DOWNLOAD_CAPABILITY_DISABLED` | Cron download/recovery |
| CONTENT_FETCH_DISABLED | `CONTENT_FETCH_DISABLED` | Content / extraction |
| DISABLED (master download) | `ACQUISITION_DISABLED` | Download service |
| Download capability OFF | `ATTACHMENT_DOWNLOAD_DISABLED` | Download service |
| Provider mal configuré | `PROVIDER_NOT_CONFIGURED` | Extraction (existant) |

`FEATURE_DISABLED` (tenant sync) et `MASTER_DISABLED` (cron) coexistent volontairement ; unifier = lot ultérieur.

## Runbook

Ticket documentaire : créer `RB-PLAN-ACQ-001-activation-flags.md` dans le lot **OPS-007**.
