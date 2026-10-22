# PLAN-AGENT-GATEWAY-001 — LOT-1W-1a — Extraction à parité stricte des cœurs `createChantier` et `affecterEquipe`

| Champ | Valeur |
|-------|--------|
| Plan | PLAN-AGENT-GATEWAY-001 — ADR-PLAN-002 *Accepté* (2026-10-22), SPEC-PLAN-AGENT-GATEWAY-002 (LOT-1W rév. 6) §5.1–5.2 |
| Sous-lot | **1W-1a** — refactor **sans changement fonctionnel** : `createChantier` et `affecterEquipe` deviennent des adaptateurs de `chantier-create.core.ts` et `assignment-team.core.ts` |
| Fiche | FICHE-LOT-1W-1a rév. 3 (2026-10-22), §9 appliqué avant toute capture |
| Branche | `refactor/plan-agent-gateway-002-lot-1w-1a-core-extraction`, worktree `~/Development/planificator-lot-1w-1a` |
| Worktree de référence | `~/Development/planificator-lot-1w-1a-ref`, HEAD **détaché** sur BASE_SHA, jamais modifié hors `tests/chantiers/parity/**` (capture uniquement) |
| **BASE_SHA** | `a84c73fe7e89c04943e356df99679fe0aca83ed1` — `git fetch origin && git rev-parse origin/main` le 2026-10-22 (= `a84c73f`, dernière base connue de la fiche, reconfirmée) |
| Poste | Claude Code sur le Mac de Nizar ; ni clone VPS ni `875b4f3` |
| Autorisation | IN_BUILD 1W-1a (Nizar, 2026-10-22) : implémentation locale, **un seul commit** (harnais + preuves + MANIFEST), refactor **non commité**. Aucun push, fusion, migration, déploiement, activation. |
| Commit local n° 1 | `6aaf415` — `test(chantiers): LOT-1W-1a — harnais de parité et références figées sur a84c73fe7e89c04943e356df99679fe0aca83ed1` (133 fichiers). Amendé trois fois avant livraison (dossier `build/` ignoré par `.gitignore` → `tsc-build/` ; garde « use server » limitée à la directive ; normalisation des journaux en `perl`) — un seul commit au final, non poussé |
| Vérification preview | **non réalisée** (aucune autorisation distincte de push/déploiement) ; aucun essai manuel sur base |
| Rôles | Reviewer indépendant : Codex ; Autorité : Nizar |

## 1. Périmètre livré (liste fermée §2)

| Fichier | État | Nature |
|---------|------|--------|
| `src/lib/actions/write-actor.ts` | nouveau, **non commité** | `WriteActor`, `CoreResult<T>`, `CoreErrorCode` (SPEC §5.1) ; `agent?` non renseigné ; **+ `TRANSACTION_FAILED`** (voir §5.1) |
| `src/lib/actions/chantier-create.core.ts` | nouveau, non commité | `createWorksiteCore(input, actor, deps)` : `createChantierSchema` inchangé, `client.findFirst`, géocodage via port (appelé seulement si `address`), `worksite.create` mêmes champs/valeurs/ordre |
| `src/lib/actions/assignment-team.core.ts` | nouveau, non commité | `assignTeamCore(input, actor, deps)` : mêmes contrôles, mêmes requêtes (conflit équipe **sans** filtre d'entreprise), même transaction, mêmes messages au caractère près, e-mail injecté en port et déclenché **au même point** (dans la transaction, après `company.findUnique`) |
| `src/lib/actions/chantier.actions.ts` | modifié, non commité (+42 / −168) | `createChantier` et `affecterEquipe` = adaptateurs : `requireAdmin` inchangé, lecture `FormData` inchangée, ports Prisma en passe-plat (`(args) => prisma.x.y(args)`), `$transaction(fn)`, `revalidatePath` et `console.error("[affecterEquipe] transaction error:", …)` dans l'adaptateur ; les 10 autres actions du fichier byte-identiques |
| `tests/chantiers/chantier-create.core.test.ts` | nouveau, non commité | T-CORE-1, T-CORE-3 (create), T-CORE-7 : rejeu de parité + cœur seul |
| `tests/chantiers/assignment-team.core.test.ts` | nouveau, non commité | T-CORE-2, T-CORE-3 (assign), T-CORE-6, T-CORE-7 : rejeu de parité + non-durcissement + cœur seul |
| `tests/chantiers/parity/harness.ts` | commit n° 1 | doubles `@/auth`, `@/lib/prisma` (enregistreur, `inTx`, `$transaction(fn)` avec rejet = rollback), `@/lib/geo/geocode.port`, `@/lib/email`, `next/cache` ; horloge figée `2026-11-02T08:00:00Z` (`mock.timers`) ; 56 cas (23 `createChantier`, 33 `affecterEquipe`) |
| `tests/chantiers/parity/record-reference.ts` | commit n° 1 | enregistrement sur BASE_SHA ; gardes a/b/c/d (§9.1) ; refuse si l'import de `chantier.actions.ts` lève ; refuse tout snapshot existant ; chaque cas exécuté deux fois (reproductibilité) |
| `tests/chantiers/parity/scope-guard.test.ts` | commit n° 1 | T-CORE-5 contre BASE_SHA figé + inventaire des non suivis + cohérence du MANIFEST (empreintes = `git show BASE_SHA`, SHA-256 des snapshots) |
| `tests/chantiers/parity/reference/*.json` (112) + `MANIFEST.json` | commit n° 1 | 56 cas × 2 fuseaux (`.utc.json`, `.europe-paris.json`) ; MANIFEST : BASE_SHA, horloge, mécanisme, empreintes du graphe d'import (9 fichiers), par fuseau : date réelle, Node, commande, SHA-256 de chaque snapshot |
| `tests/chantiers/parity/reference/tsc-build/` | commit n° 1 | `tsc-raw.txt`, `tsc-exit.txt`, `next-build-raw.txt`, `next-build-exit.txt`, copies normalisées, `build-env.txt`, README |
| `tests/chantiers/parity/reference/t-core-8/` | commit n° 1 | les huit sorties du test discriminant |
| `tests/chantiers/parity/after/` | non suivi (preuves de revue) | journaux `tsc`/`build`/`test:chantiers` **après** refactor, diffs normalisés, `git-diff-base-stat.txt`, `git-ls-files-others.txt`, `refactor-uncommitted.diff` (1 185 lignes) |
| `package.json` | ligne `test:chantiers` (commit n° 1 puis étendue, non commitée) | `<5 tests préexistants> && TZ=UTC node --import tsx --experimental-test-module-mocks --test scope-guard + 2 tests cœur && TZ=Europe/Paris … 2 tests cœur` ; aucune dépendance ajoutée ; `RESEND_API_KEY` inutile (`@/lib/email` doublé, jamais chargé) |
| `docs/specs/agent-gateway/LOT-1W-1a.md` | ce document, non commité | |

**Non livré, volontairement** : filtre `companyId` sur les conflits, mapping `P2002`, bornes, arithmétique UTC, champ `agent`, tout fichier sous `src/lib/agent-gateway/`, `src/app/api/`, `src/middleware.ts`, `prisma/`, `next.config.ts`. **Non déposés dans le dépôt** : FICHE-LOT-1W-1a, ADR-PLAN-002, LOT-1W-proposal (joints au contexte ; import documentaire hors liste fermée).

## 2. Environnement d'exécution (constats)

| Point | Constat |
|-------|---------|
| Node | **Aucun runtime Node n'était installé sur le Mac** (ni `node`, ni `brew`, ni `nvm`). Sur décision de Nizar, Node **v22.23.4** LTS a été installé depuis `nodejs.org` (archive `node-v22.23.4-darwin-arm64.tar.gz`, SHA-256 vérifiée `c9e1dbc7…`) dans `~/.local/node22`, PATH ajouté à `~/.zshrc`/`~/.zprofile`. npm 10.9.9 |
| Dépendances | `node_modules` du clone principal **creux** (0 `package.json`) ; `npm ci` exécuté dans chaque worktree depuis le `package-lock.json` de BASE_SHA (926 paquets). `prisma/` du clone principal diffère de BASE_SHA : aucun partage de `node_modules` |
| Doubles de modules | `node:test` `mock.module` avec `--experimental-test-module-mocks`, vérifié sur un import **réel** de `chantier.actions.ts` : les cinq frontières interceptées, y compris l'`import()` dynamique de `geocode.port` ; sans le drapeau : `mock.module is not a function`. tsx charge les `.ts` en **CommonJS** (pas de `"type": "module"`) : pas d'`await` de premier niveau dans le harnais |
| `requireAdmin` à BASE_SHA | identique à la fiche §3bis-4bis : rôles `ADMIN`/`SUPER_ADMIN`/`TEAM_LEADER`, messages « Non authentifié », « Accès refusé », « Entreprise introuvable » — aucun écart |
| Conflit équipe à BASE_SHA | `where: { teamId, date: { in } }` **sans** `team.companyId` (comme à `a84c73f` dans la fiche) ; T-CORE-6 le reflète |

## 3. Protocole exécuté (ordre §9.1)

1. `git fetch origin` → BASE_SHA ; deux worktrees créés depuis BASE_SHA (ref détaché, refactor sur branche).
2. `tsc` et `npm run build` capturés sur le worktree de référence **vierge** (avant tout fichier du harnais).
3. Harnais ajouté (non suivi) dans le worktree de référence ; `tsc` relancé : **aucune différence** avec la capture vierge (harnais type-propre).
4. **T-CORE-8** (§4 ci-dessous), dont les deux captures acceptées (`TZ=UTC` puis `TZ=Europe/Paris`).
5. Scope-guard sur le worktree de référence : 12/12.
6. Copie du harnais et des références dans le worktree refactor, ligne `test:chantiers`, `npm run test:chantiers` (60/60 + 12/12), **commit n° 1**.
7. Refactor (non commité) ; `tsc`, `npm run test:chantiers`, `npm run build` ; comparaison aux captures de BASE_SHA.

## 4. T-CORE-8 — test discriminant du garde (worktree de référence, HEAD `a84c73f` inchangé)

| Étape | Sortie | Code | Snapshots écrits |
|-------|--------|------|------------------|
| 1. ligne 41 de `chantier.actions.ts` modifiée, sans commit | `[garde a] OK` · `[garde b] REFUS — M src/lib/actions/chantier.actions.ts` · `[garde c] OK` · `[garde d] REFUS — empreinte 0c40d5f5… ≠ BASE_SHA 76329919…` · `REFUS — intégrité des sources non établie, aucune référence enregistrée` | 1 | 0 |
| 2. `git checkout -- src/lib/actions/chantier.actions.ts` (ce seul fichier) | 4 gardes OK · `56 références écrites … (TZ=UTC)` | 0 | 56 |
| 3. `src/x.ts` non suivi ajouté | `[garde c] REFUS — fichier(s) non suivi(s) interdit(s) : src/x.ts` · refus | 1 | 0 |
| 3 bis. `src/x.ts` retiré | 4 gardes OK · `56 références écrites … (TZ=Europe/Paris)` | 0 | 56 |
| compl. relance `TZ=UTC` | `REFUS — snapshot(s) déjà présent(s) pour TZ=UTC, jamais régénérés : …` | 1 | 0 |
| compl. `TZ=America/New_York` | `REFUS — TZ doit valoir UTC ou Europe/Paris` | 2 | 0 |
| compl. `package.json`, seule la ligne `test:chantiers` | `[garde b] OK` (puis refus « snapshots déjà présents ») | 1 | 0 |
| compl. `package.json`, ligne `name` | `[garde b] REFUS — … package.json (lignes hors test:chantiers : …)` | 1 | 0 |

Sorties intégrales : `tests/chantiers/parity/reference/t-core-8/`. Un premier passage avait affiché `M rc/lib/…` (sortie `git status` rognée par le script) : corrigé (lecture non rognée), **références supprimées et toute la séquence rejouée** avec le script final.

## 5. Preuves de parité après refactor (2026-10-22)

| Test | Résultat |
|------|----------|
| T-CORE-4 — `tests/chantiers/*` préexistants (5 fichiers, inchangés) | **60/60** |
| T-CORE-5 — scope-guard (12 assertions) | **12/12** |
| T-CORE-1/2/3 — rejeu des 56 cas (retour + trace ordonnée avec `inTx` + e-mail + revalidation + `console.error`) contre la référence, égalité profonde, `TZ=UTC` | **56/56** (+ 24 tests de cœur seul et d'invariants : **92/92** au total) |
| T-CORE-7 — même rejeu sous `TZ=Europe/Paris` | **56/56** (**80/80** avec les tests de cœur) |
| T-CORE-6 — `where` du conflit équipe = `{ teamId, date }` dans la référence **et** dans le cœur refactoré | OK |
| `npm run test:chantiers` (les trois invocations) | code de sortie 0 |
| `tsc --noEmit` | exit **2 → 2**, **52 → 52** erreurs, diff des journaux normalisés **vide** (`after/tsc-diff.txt`) ; les 52 erreurs sont préexistantes, toutes sous `tests/` (acquisition, booking), hors périmètre |
| `npm run build` | exit **0 → 0**, **1 → 1** avertissement (préexistant : `jose/deflate.js` / Edge Runtime via `next-auth`) ; diff normalisé (`after/next-build-diff.txt`) : 3 lignes de **cadrage** de colonnes (tailles `<SIZE>` alignées différemment), aucune route, aucun avertissement, aucune erreur nouveaux |
| T-CORE-7 — inventaire UTC vs Europe/Paris **dans la référence** | 32 cas identiques, 24 divergents, tous `affecterEquipe` : instants `setHours(0,0,0,0)` décalés d'une heure dans les `args` ; un seul **retour** différent (`assign-team-conflict-late-evening-date`, « 04 » vs « 05 novembre » pour une date de conflit à 23:30 UTC). Référence et refactor divergent **de la même façon** (rejeu vert dans les deux fuseaux) — parité, pas correction (1W-1b) |

Références **jamais régénérées** : le script refuse tout snapshot existant et `HEAD ≠ BASE_SHA` ; le MANIFEST porte le SHA-256 de chaque snapshot, vérifié par T-CORE-5.

### 5.1 Choix d'implémentation à valider en revue (aucun n'altère le comportement observable)

| # | Choix | Motif |
|---|-------|-------|
| 1 | **`CoreErrorCode` étendu d'une valeur : `TRANSACTION_FAILED`** (`details: { message, cause }`) | La SPEC §5.1 n'a aucun code pour une transaction annulée, alors que l'UI de BASE_SHA la traite distinctement (message générique + `console.error` avec le message d'origine). L'alternative (exception typée relancée par le cœur) gardait la liste SPEC intacte mais mélangeait résultats et exceptions. L'adaptateur ne capture **que** ce code (les erreurs hors transaction se propagent, comme à BASE_SHA) |
| 2 | **E-mail : port injecté (`deps.sendAssignmentCreatedEmail`) appelé par le cœur au même point**, dans la transaction, avec `.catch(() => {})` | La fiche §3.1 enregistre si l'e-mail est appelé *avant ou après* la transaction ; le déplacer après le commit (ADR D-W6) changerait la trace. SPEC §5.1 prévoit les ports e-mail/géocodage dans `deps` ; la fonction réelle reste importée dans l'adaptateur uniquement |
| 3 | **Pas de `now`** dans `deps` | Ni `createChantier` ni `affecterEquipe` ne lisent l'horloge à BASE_SHA ; une dépendance inutilisée serait trompeuse. À ajouter en 1W-1b avec l'arithmétique UTC |
| 4 | **`geocode` lazy** : l'`import()` dynamique de `@/lib/geo/geocode.port` reste dans le port de l'adaptateur, exécuté seulement si `address` | Même graphe de chargement qu'à BASE_SHA |
| 5 | Messages UI portés par `details.message` (byte-identiques), adaptateur en passe-plat ; `coreErrorMessage` lève si un code arrive sans message (inatteignable, défense) | Un seul endroit pour les textes ; la passerelle (1W-3) utilisera les codes |
| 6 | Entrées brutes typées `string` (cast `as string` de l'adaptateur conservé ; `null` à l'exécution si clé absente) | Parité du `FormData` ; le cas `create-zod-description-absent` capture ce comportement (`Expected string, received null`) |

## 6. Constats hors périmètre (ticket / 1W-1b, **non corrigés**)

| Constat | Détail |
|---------|--------|
| `npm run build` réécrit un fichier **suivi** | `public/sw.js` (next-pwa, noms de variables du minifieur) ; restauré par `git checkout -- public/sw.js` après chaque build, dans les deux worktrees |
| `"use server"` dans un `*.core.ts` préexistant | `src/lib/actions/acquisition-conversion.actions.core.ts` contient la directive à BASE_SHA ; la garde d'invariant 6 est donc limitée aux fichiers du lot |
| `.gitignore` ignore tout dossier `build/` | d'où le nom `tsc-build/` pour les preuves |
| 52 erreurs `tsc` préexistantes | toutes sous `tests/acquisition/*` et `tests/booking/*` (déjà notées en LOT-1A) |
| Dépendance fuseau | `setHours(0,0,0,0)`, `Intl.DateTimeFormat("fr-FR")` sur des dates UTC tardives : divergence documentée par T-CORE-7, à traiter en 1W-1b (T-DATE-5) |
| Zod | `description`/`address` absents du `FormData` ⇒ `null` ⇒ rejet « Expected string, received null » ; `dailyHours` vide ⇒ 0 ⇒ « Number must be greater than or equal to 1 » ; `startDate` non parsable ⇒ message du `refine` de date (comparaison d'`Invalid Date`) — comportements de BASE_SHA, reproduits |
| Conflit équipe non filtré par entreprise | T-CORE-6 ; durcissement 1W-1b (T-HARD-1/2/3) |
| Clone principal | `node_modules` creux, branche `feat/navigation-modular-sections` avec modifications non commitées (non touché) |

## 7. Livrables pour revue (worktree `planificator-lot-1w-1a`)

- `git log --oneline -2` : `6aaf415` (commit n° 1) sur `a84c73f`.
- `git diff BASE_SHA --stat` : 134 fichiers (133 du commit n° 1 + `chantier.actions.ts`), **sans** les 5 fichiers non suivis → `tests/chantiers/parity/after/git-diff-base-stat.txt`.
- `git ls-files --others --exclude-standard` : `write-actor.ts`, les deux cœurs, les deux tests cœur, `tests/chantiers/parity/after/**`, ce document → `after/git-ls-files-others.txt`.
- Diff complet du refactor (non commité, nouveaux fichiers inclus) : `after/refactor-uncommitted.diff` ; stat : `package.json` +1/−1, `chantier.actions.ts` +42/−168.
- Journaux `tsc`/`build` avant : `reference/tsc-build/` ; après : `after/` ; diffs normalisés : `after/tsc-diff.txt` (vide), `after/next-build-diff.txt`.
- Sortie complète de `npm run test:chantiers` : `after/test-chantiers.txt`.

## 8. Rollback

Aucune donnée, aucun schéma, aucune configuration touchés. Le refactor est non commité (`git checkout -- src/lib/actions/chantier.actions.ts package.json` + suppression des cinq fichiers non suivis) ; le commit n° 1 est local, revert ou suppression de branche possible sans effet.

## 9. Reste à faire avant fusion

Revue indépendante (Codex) du diff et des choix §5.1 ; décision de l'Autorité sur le commit du refactor ; push et PR sur autorisation distincte ; CI inexistante dans le dépôt (constat LOT-1A inchangé) ; vérification preview **non réalisée** (autorisation distincte requise, §5bis).
