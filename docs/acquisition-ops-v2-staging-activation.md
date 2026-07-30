# PLAN-ACQ-V2 — Activation staging (Agent 2 / Lot C) — R2

Runbook **ops** pour activer le pipeline Acquisition jusqu’à `PENDING_REVIEW`.
Architecture : **GMAIL_INBOX** générique + **registre partenaires** (multi-clients).
LAURALU n’est qu’un **exemple de donnée** registre, pas une dépendance code.

Aucune activation silencieuse. Aucun secret dans ce document.

## Prérequis d’identification (GO/NO-GO)

Avant toute action, noter explicitement (valeurs d’environnement locales / dashboard — **ne pas coller de secrets ici**) :

| Élément | Où vérifier | Attendu |
|---------|-------------|---------|
| Projet Vercel | Dashboard Vercel → Settings → General → Project Name | projet **staging** dédié (ex. `planificator-staging`) — **pas** production |
| Scope déploiement | Vercel → Domains / Git branch | branche / env Preview ou Staging |
| Base cible | Variable `DATABASE_URL` de l’env Vercel Staging (valeur tronquée / host only) | host Neon/Postgres **staging** distinct de prod |
| `CRON_SECRET` | Env staging | défini, distinct de prod |
| Tenant E2E | Ops | `companyId` connu |

**NO-GO** si le projet Vercel ou le host DB correspond à la production.

## 1. Backup / point de restauration

Avant migrate :

1. Snapshot Neon (ou `pg_dump`) de la base **staging** identifiée ci-dessus.
2. Noter l’heure UTC + identifiant snapshot.
3. Confirmer procédure restore documentée côté hébergeur.

Sans backup vérifiable → **NO-GO**.

## 2. Migrations (manuel — Vercel n’exécute PAS `migrate deploy`)

Le build Vercel (`prisma generate && next build`) **génère le client** mais **n’applique aucune migration SQL**.

Sur une machine ops pointant vers `DATABASE_URL` **staging** uniquement :

```bash
# 1) Statut avant
npx prisma migrate status

# 2) Deploy manuel
npx prisma migrate deploy

# 3) Client
npx prisma generate

# 4) Revérifier
npx prisma migrate status
```

Vérifier tables / colonnes :

- `acquisition_orchestrator_leases`
- `acquisition_partner_emails` + `allowCreateClient` / policy partenaires
- `acquisition_messages.resolvedPartnerId` / `threadId`
- `acquisition_decision_journals`

## 3. Bootstrap registre + readiness

```bash
npm run db:bootstrap:acquisition-partners
npm run db:check:acquisition-partners-readiness
```

Critères readiness durable : `companiesReady === companiesTotal` (partenaire actif + identité domaine **ou** email).

Sans identité active → sync Gmail **fail-closed** (`NO_ACTIVE_PARTNER_IDENTITIES`) — pas de scan large.

## 4. Feature flags (staging Lot C)

| Flag | Lot C |
|------|-------|
| `PLANIFICATOR_ACQUISITION_ENABLED` | ON |
| `ACQUISITION_ORCHESTRATOR_CRON_ENABLED` | ON |
| content / extraction / attachments | ON selon matrice |
| `ACQUISITION_CONVERSION_ENABLED` | **OFF** |
| `ACQUISITION_AUTO_APPROVE_ENABLED` | **OFF** |
| `ACQUISITION_AUTO_CONVERT_ENABLED` | **OFF** |

Contrôle : `getAcquisitionStagingReadiness(companyId)` → `readyForOrchestratorE2E === true` (exige autoApprove OFF + domaines actifs + lease table).

## 5. Scheduler

`GET /api/cron/acquisition-orchestrator`
Header : `Authorization: Bearer $CRON_SECRET`
Hors `vercel.json`. Intervalle 5–15 min.
Ne pas activer les 5 crons unitaires en parallèle du même tenant.

## 6. E2E contrôlé

1. Email **contrôlé** (domaine ou adresse allowlist du registre)
2. Sync → `DRAFT_CREATED` + `resolvedPartnerId` + draft `PENDING_EXTRACTION`
3. Content → extraction → `PENDING_REVIEW`
4. Pas d’auto-convert (flags OFF)
5. `GET /api/acquisition/ops-snapshot` (ADMIN) : compteurs + readiness
6. **Contrôle doublons** : pas de second chantier pour le même email/adresse
7. **Contrôle logs** : préfixe `[acquisition-orchestrator]` / pas de `LEASE_STOLEN` inattendu

## 7. Rollback flags

1. `ACQUISITION_ORCHESTRATOR_CRON_ENABLED` → unset / false
2. Master OFF si besoin
3. Lease : laisser expirer (TTL) ou release manuel si zombie
4. Ne pas rollback migrate sans restore snapshot

## 8. Critères GO / NO-GO

**GO** si et seulement si :

- [ ] Projet Vercel = staging (pas prod)
- [ ] `DATABASE_URL` host = staging
- [ ] Backup / snapshot pris
- [ ] `migrate status` clean après `migrate deploy`
- [ ] Readiness registre OK
- [ ] autoApprove OFF + autoConvert OFF
- [ ] E2E email contrôlé → PENDING_REVIEW
- [ ] Aucun doublon chantier inattendu
- [ ] Logs sains

**NO-GO** sinon — ne pas activer le scheduler.

## Suite (hors Lot C)

- Lot F : auto **par partenaire** + kill-switch env + `allowCreateClient` (défaut OFF)
- Géocode / « À affecter » : Lot G (non bloquant)
- Fencing mid-worker hors Gmail : voir `docs/acquisition-ops-v2-fencing-workers.md`

## Configuration policies partenaires (R3 — sans UI)

Pas d’activation globale accidentelle : `createPartner` conserve les défauts OFF.

Pour un ADMIN / SUPER_ADMIN ops (service admin, pas SQL ad hoc) :

```ts
await acquisitionPartnerAdminService.updatePartnerPolicy({
  companyId: "<tenant>",
  partnerId: "<id>",
  autoApproveEnabled: false, // rester OFF en staging Lot C
  autoConvertEnabled: false,
  allowCreateClient: false,
  minConfidence: 0.75, // borné [0,1]
  requireExactEmail: false,
  priority: 100,
})
```

`active` n’est **pas** modifié par `updatePartnerPolicy` (activate/deactivate séparés).
Journal structuré stdout : `[acquisition-partner-admin] POLICY_UPDATED`.
