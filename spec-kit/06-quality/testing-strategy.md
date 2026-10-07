# Stratégie de tests

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (`package.json`, `tests/`, helpers). Norme : ES-001 §18.

## Outillage constaté

- Runner : `node --import tsx --test` (runner natif Node, pas Jest/Vitest). Tests en `.test.ts` et `.test.tsx` (rendu React).
- Scripts par domaine : `test:vehicules`, `test:equipes`, `test:employes`, `test:chantiers`, `test:navigation`, `test:booking`, `test:booking:unit`, `test:booking:identity:pg`, `test:acquisition` (+ `:flags`, `:conversion:pg`), `test:integration` (+ `:persistence:pg`, `:mail-shadow`), `test:security:hotfix`.
- **Les listes de fichiers sont codées en dur dans `package.json`** : un nouveau fichier de test n'est exécuté que s'il y est ajouté. **VÉRIFIÉ : 43 des 174 fichiers de test (`*.test.ts` / `*.test.tsx`) ne figurent dans aucun script**, dont `tests/chantiers/chantier-update-nullable-dates.test.ts`, `tests/auth/plan-auth-superadmin-001.test.ts` et plusieurs `*.pg.test.ts` d'acquisition. Ils ne sont donc exécutés par aucune commande `npm run test:*`. À traiter par un lot dédié ; à vérifier à chaque PR.
- Variables factices pour les tests : `DATABASE_URL`, `RESEND_API_KEY` (valeurs de test dans les scripts).

## Niveaux

| Niveau | Quand | Modèle |
|--------|-------|--------|
| Unitaire / handler à dépendances injectées | toujours | `tests/vehicules/trucks-api.test.ts` |
| Contenu SQL d'une migration (sans base) | toute migration | `tests/vehicules/v1*-schema-migration.test.ts` |
| Rendu UI | composants avec logique d'affichage | `tests/vehicules/vehicules-render.test.tsx` |
| **PostgreSQL réel (`*.pg.test.ts`)** | invariants de base (trigger, CHECK, unicité, concurrence) | modèle d'**invariants** : `tests/booking/booking-identity-isolation.pg.test.ts`, `tests/acquisition/multi-gmail-identity-lock.pg.test.ts` ; modèle de **garde** : `tests/integration/persistence/*` |
| Architecture (imports interdits) | frontières strictes | `tests/integration/architecture/` |
| Sécurité | auth, cron, tenant | `tests/security/plan-security-hotfix-001.test.ts` |

## Garde-fou des tests PostgreSQL

**La garde n'est PAS universelle** (VÉRIFIÉ). `tests/booking/booking-identity-isolation.pg.test.ts` et `tests/acquisition/multi-gmail-identity-lock.pg.test.ts` lisent `TEST_ACQUISITION_DATABASE_URL` directement, sans appeler `assertSafeDisposableTestDatabaseUrl` ; le test booking lance même `prisma migrate deploy` sur cette URL, et fait partie de `npm run test:booking`. Seuls `tests/integration/persistence/*` (via `require-pg-env`) et `consultation-detection-selection.integration.test.ts` l'utilisent. **Ne pas présenter ces deux tests comme modèle de sécurité**, seulement comme modèle d'invariants. Tout **nouveau** test PostgreSQL doit appeler la garde.

`tests/integration/persistence/helpers/safe-test-database-url.ts` refuse toute URL qui ne ressemble pas à une base **jetable de test** (marqueurs `test`, `testing`, `disposable`, `ephemeral`… dans le nom ; noms ambigus `postgres`, `template*` refusés). Variables : `TEST_INTEGRATION_DATABASE_URL` (prioritaire), `TEST_ACQUISITION_DATABASE_URL`. **Jamais** de test contre une base partagée ou de production ; l'URL n'est jamais journalisée.

## Exigences minimales par type de changement

| Changement | Tests exigés |
|-----------|--------------|
| Route API / action | handler unitaire : 401, 403 rôle, `NO_COMPANY`, payload invalide, **non-accès inter-entreprises** |
| Migration | test de contenu SQL + test pg si invariant de base |
| Règle métier à concurrence | test de deux requêtes croisées + 409 typé |
| UI à logique | test de rendu |

## CI

**Aucun workflow CI trouvé** (`.github/workflows` absent sur origin/main) alors que ES-001/PLAN-GOVERNANCE-001 exigent une « CI requise verte » avant merge. **À AUDITER** : la CI est-elle ailleurs (GitHub Actions hors dépôt, Vercel checks) ? Sinon : **DÉCISION REQUISE** pour en créer une.

## Lacunes constatées

Aucun **dossier** de tests pour `planning`, `finance`/factures, notes de frais, pointage, logements (des tests indirects existent : `tests/chantiers/assignment-ui-policy.test.ts`, `tests/booking/*` pour la création d'`Accommodation`) ; aucun test pg pour Vehicles. Voir `05-domains/modules-status.md`.
