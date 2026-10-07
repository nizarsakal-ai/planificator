# Architecture des données

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (`prisma/schema.prisma` sur origin/main, ~1800 lignes ; liste des modèles relevée sur la branche de travail, identique pour les modèles cités).

## Principes

- PostgreSQL via Prisma 5.22 (`prisma/schema.prisma`, `prisma/migrations/`, `migration_lock.toml`).
- Identifiants : `String @id @default(cuid())` (modèles Vehicles, Acquisition).
- Tables nommées par `@@map("snake_case_pluriel")` (ex. `trucks`, `truck_assignments`).
- Tenant : `companyId` présent sur les modèles métier ; voir `03-security/multi-tenancy.md`.

## Familles de modèles

| Famille | Modèles |
|---------|---------|
| Tenant & accès | `Company`, `CompanySettings`, `User`, `Invitation`, `PasswordReset` |
| Ressources | `Employee`, `Team`, `TeamMember`, `Truck`, `TruckAssignment` |
| Chantiers & planning | `Client`, `ClientProfile`, `Worksite`, `Assignment`, `EmployeeAssignment`, `Extension`, `Document`, `Signature`, `DailyReport`, `Timeclock`, `Absence` |
| Finance | `Article`, `Quote`, `QuoteLine`, `Invoice`, `InvoiceLine`, `DocumentCounter`, `ExpenseReport` |
| Logement & booking | `Accommodation`, `PendingAccommodation`, `GmailConnection`, `ProcessedGmailMessage` |
| Acquisition | `AcquisitionMessage`, `AcquisitionMessageContent`, `AcquisitionContentFetchState`, `WorksiteImportDraft`, `AcquisitionDecisionJournal`, `AcquisitionAttachment`, `AcquisitionAttachmentAccessLog`, `AcquisitionScanCursor`, `AcquisitionPartner*`, `AcquisitionOrchestratorLease`, `AcquisitionGmailConnection` |
| Intégration | `IntegrationConnection`, `InboundEnvelope`, `NormalizedInbound` |
| Transverse | `HistoryLog`, `Notification` |

## Invariants portés par la base (exemples vérifiés — Vehicles)

- Une seule période d'affectation ouverte par véhicule : colonne `openForTruckId @unique` maintenue **exclusivement par trigger SQL** (`truck_assignments_v1a_open_for_truck_id`).
- Un véhicule archivé n'a ni équipe ni chauffeur : CHECK `trucks_v1a_archived_unassigned_check`.
- Chronologie : CHECK `truck_assignments_v1b_chronology_check` (`endedAt >= startedAt`) ; motif obligatoire : `truck_assignments_v1b_reason_required_check`.
- FK historiques en `ON DELETE RESTRICT` : un historique n'est jamais effacé par la suppression de son véhicule, chauffeur, équipe ou entreprise.

Détails : `04-database/integrity-rules.md`.

## À AUDITER

- Politique de rétention et d'anonymisation (RGPD) : aucun document trouvé.
- Index et plans de requête des tables volumineuses (acquisition).
