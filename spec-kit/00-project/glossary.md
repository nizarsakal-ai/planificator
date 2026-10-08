# Glossaire

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (noms du schéma Prisma et des routes) ; les définitions métier fines sont **À CONFIRMER** par l'utilisateur.

| Terme métier | Nom technique | Remarque |
|--------------|---------------|----------|
| Entreprise / tenant | `Company`, `companyId` | Frontière d'isolation |
| Utilisateur | `User` (+ `Role`) | Rôles : SUPER_ADMIN, ADMIN, TEAM_LEADER, EMPLOYEE, CLIENT |
| Employé | `Employee` | Page `/employes` |
| Équipe | `Team`, `TeamMember` | Page `/equipes` |
| **Véhicule** | **`Truck`** (table `trucks`) | Le code parle de `Truck`/camion, l'UI de « Véhicules » (`/vehicules`), l'API de `/api/trucks` |
| Période d'affectation d'un véhicule | `TruckAssignment` (table `truck_assignments`) | Historique ; une seule période ouverte par véhicule |
| Chantier chez le client | `Worksite` | Page `/chantiers` ; ne pas confondre avec le « logement » |
| Affectation | `Assignment`, `EmployeeAssignment` | Planning |
| Logement | `Accommodation` | Hébergement des équipes |
| Client | `Client`, `ClientProfile` | Rôle `CLIENT` : espace `/mes-chantiers` |
| Acquisition | `Acquisition*` | Pipeline e-mail → brouillon → chantier |
| Booking | `PendingAccommodation`, `BookingGmail*` | Réservation de logements depuis Gmail |
| Plateforme d'intégration | `IntegrationConnection`, `InboundEnvelope`, `NormalizedInbound` | Couche générique multi-tenant |

## Vocabulaire de gouvernance

- **ES-001** : ENGINEERING-STANDARD-001. **PRR** : Production Readiness Review. **MODULE CLOSED** : clôture selon ES-001 §26.
- **Revue indépendante** : revue par un agent ou une personne distincts de l'auteur (voir `02-governance/ai-agent-rules.md`).
- **Preuve** : sortie de test, requête SQL, capture ou log permettant de vérifier une exigence ; une affirmation sans preuve ne compte pas.
