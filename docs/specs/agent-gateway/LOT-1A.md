# PLAN-AGENT-GATEWAY-001 — LOT-1A — Schéma, flags, secrets

| Champ | Valeur |
|-------|--------|
| Plan | PLAN-AGENT-GATEWAY-001 (ADR-PLAN-001 *Accepté*, SPEC-PLAN-AGENT-GATEWAY-001 rév. 8, module SPECIFIED) |
| Lot | LOT-1A — fondation : 3 enums, 5 tables `agent_*`, flags, secrets, tests. **Aucune route, aucune logique, aucune donnée.** |
| Branche | `feat/plan-agent-gateway-001-lot-1a-schema`, worktree dédié `planificator-agent-gateway-lot-1a` |
| Base | `origin/main` = `84a991c` (`git fetch` 2026-10-21 13:58 UTC ; comparaison B.1bis de la fiche rejouée, identique) |
| État module | IN_BUILD (non exposé) |
| Autorisation | Implémentation autorisée par l'Autorité le 2026-10-21 (périmètre fiche rév. 4 §B). Tests sur bases jetables uniquement. Aucun déploiement, aucune migration sur préproduction/production, aucune activation. |

## Périmètre livré (liste fermée)

| Fichier | Nature |
|---------|--------|
| `prisma/schema.prisma` | +126 lignes, 0 supprimée : section `AGENT GATEWAY` (enums `AgentPrincipalStatus`, `AgentAccessOutcome`, `AgentScope` ; modèles `AgentPrincipal`, `AgentAccessLog`, `AgentRateWindow`, `AgentAnonRateWindow`, `AgentGatewayControl`) ; relations inverses `Company.agentPrincipals`, `User.createdAgentPrincipals` (sans effet SQL) |
| `prisma/migrations/20261021150000_agent_gateway_foundation/migration.sql` | générée par `prisma migrate dev --create-only` sur base jetable PostgreSQL 17.11, **relue et bornée** (voir « Dérive préexistante ») |
| `prisma/migrations/20261021150000_agent_gateway_foundation/ROLLBACK.sql` | rollback documenté, **non exécuté par Prisma**, autorisé tant qu'aucune donnée n'existe (SPEC §13.2) |
| `src/lib/integration/flags/platform-flag-names.ts` | +3 noms `INTEGRATION_AGENT_GATEWAY_{ENABLED,COMPANY_ALLOWLIST,RPM}` ; constantes D1a/D6a/D7 ; noms des 2 secrets |
| `src/lib/integration/flags/platform-flags.ts` | lecteurs `isAgentGatewayEnabled`, `isCompanyAllowedForAgentGateway`, `parseAgentGatewayRpm`, `getAgentGatewayRpm`, `isAgentGatewayActiveForCompany` (patron mail-shadow) |
| `src/lib/agent-gateway/scopes.ts` | table unique enum Prisma ↔ scopes du contrat ; `toContractScope`, `fromContractScope` (strict), `CONTRACT_SCOPES` |
| `src/lib/agent-gateway/secrets.ts` | lecture/validation des 2 secrets (≥ 32 octets), erreur typée sans valeur, **aucun défaut**. Politique d'encodage fermée (rév. 2) : hex pair ; base64 standard RFC 4648 §4 **padding obligatoire**, longueur ≡ 0 (mod 4) ; base64url §5 **sans padding**, longueur ≢ 1 (mod 4) ; alphabets non mélangés ; vérification par ré-encodage canonique |
| `tests/agent-gateway/{flags,scopes,secrets,migration-sql}.test.ts` | 91 tests unitaires (rév. 2 : +14 secrets, +20 migration) |
| `tests/agent-gateway/migration-guard.ts` | code de test : garde-fou de périmètre de la migration par **liste fermée** d'instructions admises (rév. 2) |
| `package.json` | script `test:agent-gateway` (aucune dépendance ajoutée) |
| `docs/specs/agent-gateway/LOT-1A.md` | ce document |

Non livré volontairement : `.env.example` (le dépôt n'en a pas — les 5 variables sont documentées ci-dessous) ; configuration ESLint (le dépôt n'en a pas ; `next lint` propose d'en créer une — hors périmètre).

## Variables d'environnement introduites (documentées, **non créées** sur Vercel)

| Variable | Rôle | Défaut |
|----------|------|--------|
| `INTEGRATION_AGENT_GATEWAY_ENABLED` | kill-switch structurel, `=== "true"` | désactivé |
| `INTEGRATION_AGENT_GATEWAY_COMPANY_ALLOWLIST` | CSV d'ids d'entreprise | vide ⇒ aucune |
| `INTEGRATION_AGENT_GATEWAY_RPM` | débit/min par principal, [1, 1000] | 120 |
| `INTEGRATION_AGENT_GATEWAY_DIGEST_SECRET` | HMAC des digests (≥ 32 octets) | **aucun** (erreur si absent, à partir de LOT-1B) |
| `INTEGRATION_AGENT_GATEWAY_CURSOR_SECRET` | signature des curseurs (≥ 32 octets) | **aucun** |

## Preuves d'exécution (2026-10-21)

Environnement : base jetable PostgreSQL **17.11** (`server_version_num` 170011), cluster éphémère dans le conteneur de travail, bases `lot1a_disposable` + `lot1a_shadow_disposable`, détruites après la session. Prisma 5.22.0.

| Test | Résultat |
|------|----------|
| T-MIG-1 — 49 migrations existantes puis `20261021150000_agent_gateway_foundation` via `prisma migrate deploy` | **OK** |
| T-MIG-2 — `prisma migrate diff --from-migrations --to-schema-datamodel` après LOT-1A | **OK** : diff = exactement les 3 instructions de dérive préexistante (ci-dessous), **0** mention `agent_*` |
| T-MIG-3 — SQL borné par liste fermée : chaque instruction doit être l'une des 4 formes admises (`CREATE TYPE` enum du lot ; `CREATE TABLE agent_*` sans REFERENCES/CHECK/UNIQUE inline, colonnes de types scalaires ou enums du lot, 1 PK ; `CREATE [UNIQUE] INDEX` sur `agent_*` ; `ALTER TABLE agent_* ADD CONSTRAINT … FOREIGN KEY … REFERENCES agent_*|companies|users("id")`) ; toute autre instruction ⇒ violation. 22 instructions classées (3 types, 5 tables, 10 index, 4 FK), 0 violation ; Restrict/SetNull/Cascade, `enabled DEFAULT false`, aucun scope WRITE | **OK** (test permanent `migration-sql.test.ts` + `migration-guard.ts`) |
| T-MIG-3bis — test discriminant du garde-fou : 18 instructions injectées (UPDATE `companies`, INSERT hors périmètre et dans une table du lot, DELETE, DROP, ALTER TABLE sur table existante, ALTER agent_* hors forme FK, FK vers table non admise, FK sur table existante, index sur table existante, CREATE TABLE/TYPE hors périmètre, ALTER TYPE, ALTER INDEX RENAME, CREATE EXTENSION, fonction, GRANT, instruction masquée par commentaire) + injection en milieu de fichier + REFERENCES inline + type de colonne JSONB ⇒ **toutes rejetées** | **OK** |
| T-SECRET-1 (rév. 2) — 11 formes malformées rejetées dont les deux reproductions de la revue (45×`Z` ; 43×`Z`+`==`), bits de fin non nuls, padding incohérent/au milieu, mélange d'alphabets, hex impair ; formes valides pour 32/33/34 octets en hex, base64 padé, base64url non padé ; **tests rejoués contre l'ancienne implémentation : 9 échecs** (preuve de discrimination) | **OK** |
| T-MIG-4 — second `migrate deploy` ⇒ « No pending migrations to apply » | **OK** |
| T-MIG-5 — `ROLLBACK.sql` sur base jetable ⇒ 0 table `agent_*`, diff contre schéma `origin/main` = dérive préexistante seulement ; ré-application OK | **OK** |
| T-SCHEMA-1/4 — 5 tables, 3 types, `agent_gateway_control` vide, version ≥ 170000 | **OK** |
| T-SCHEMA-3 — `tokenHash` unique ; `(companyId, name)` unique ; suppression `Company`/`User` **refusée** (Restrict) ; suppression du principal ⇒ `AgentAccessLog.principalId = NULL`, `AgentRateWindow` supprimées ; `aggregateKey` unique ; valeur `WORKSITES_WRITE` **rejetée** par le type | **OK** (SQL, base jetable) |
| T-FLAG-1/3/4, T-SECRET-1, T-SCOPE-MAP-1..4, T-MIG-3/3bis — `npm run test:agent-gateway` | **91/91** (rév. 1 : 57/57) |
| `prisma validate`, `prisma generate` | OK |
| `tsc --noEmit` (tsconfig inclut `**/*.ts`, tests compris) | aucune erreur sur les fichiers du lot ; **52 erreurs préexistantes** hors périmètre sur `origin/main` (non comptées, à ticketer) |
| Lint / CI | **non exécutables** : le dépôt n'a ni configuration ESLint ni workflow CI (constat, hors périmètre) |

## Dérive préexistante constatée (hors périmètre — ticket à ouvrir)

`prisma migrate diff` entre les **49 migrations de `origin/main`** et le **schéma de `origin/main`** (avant toute modification du lot) produit trois instructions :

```sql
ALTER TABLE "processed_gmail_messages" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER INDEX "acquisition_messages_companyId_source_sourceMailboxKey_external" RENAME TO "acquisition_messages_companyId_source_sourceMailboxKey_exte_key";
ALTER INDEX "pending_accommodations_companyId_sourceKind_externalSourceId_id" RENAME TO "pending_accommodations_companyId_sourceKind_externalSourceI_idx";
```

Prisma les a incluses dans le SQL généré pour LOT-1A ; elles ont été **retirées** (règle du lot : aucun `ALTER` d'une table existante). Elles concernent `booking`/`acquisition` et doivent être traitées par leurs propriétaires dans une migration dédiée (ES-001-§12.1). Tant qu'elles ne le sont pas, tout `migrate dev` futur les régénérera.

## Rollback

- Niveau opérationnel : sans objet pour ce lot (aucun comportement, aucun flag actif).
- Retrait de schéma : `ROLLBACK.sql` (tables puis types, puis ligne `_prisma_migrations`), **uniquement tant qu'aucune donnée n'existe** ; après LOT-1B, procédure SPEC §13.2.

## Révision 2 — réponse à la revue Codex du 2026-10-21

| Constat | Correction | Preuve |
|---------|-----------|--------|
| [P2] base64 permissif (45×`Z` accepté ⇒ 33 octets ; 43×`Z`+`==` accepté ⇒ 32 octets) | `secrets.ts` : politique fermée (hex pair / base64 standard padé ≡ 0 mod 4 / base64url non padé ≢ 1 mod 4, alphabets stricts) + ré-encodage canonique obligatoire ; `too_short` n'est évalué qu'après validation de la forme | 11 cas malformés + 2 reproductions exactes ; 9 échecs de ces tests sur l'ancienne implémentation |
| [P2] T-MIG-3 ne rejetait pas une instruction inconnue (UPDATE `companies` laissait 6/6 verts) | `migration-guard.ts` : liste fermée de 4 formes, validation de cible et de forme, rejet par défaut ; `migration-sql.test.ts` réécrit dessus | T-MIG-3bis : 21 injections rejetées, dont la reproduction exacte |

Migration SQL et `ROLLBACK.sql` **inchangés** (non réappliqués, conformément à la suite demandée). Aucune dépendance ajoutée. Les tests avec base (T-MIG-1/2/4/5, T-SCHEMA-*) de la rév. 1 restent valables : ni le schéma ni la migration n'ont changé.

## Reste à faire avant fusion

Revue indépendante (Codex) du diff et des preuves ; relecture de Nizar ; CI verte (le dépôt n'a pas de workflow CI visible : les tests ont été exécutés localement et sur base jetable — à signaler en revue).

## Prérequis des lots suivants (inchangés)

PostgreSQL ≥ 17 sur préproduction et production (`SHOW server_version_num`) avant LOT-1B ; lecture de B0a et décision D6b avant LOT-1D ; PRR avant toute activation.
