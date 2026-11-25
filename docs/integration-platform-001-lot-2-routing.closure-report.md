# PLAN-INTEGRATION-PLATFORM-001 — LOT-2 Runtime Routing : rapport de clôture

| Champ | Valeur |
|---|---|
| **Statut** | **IMPLÉMENTÉ, PILOTE EN OBSERVATION — NON CLOS.** Revue indépendante faite et corrigée (§3.3). Restent : seuil de parité mesuré avec la référence indépendante (§3.4, bilan du 01/12/2026), démonstration du rollback, validation manuelle de Nizar |
| **Date** | 22/11/2026 |
| **SPEC** | `docs/integration-platform-001-lot-2-routing.spec.md` (R1) |
| **Plan** | `docs/integration-platform-001-lot-2-routing.impl-plan.md` (GO de Nizar le 22/11/2026, décisions I1 à I10) |
| **Pilote** | GALYA EVENTS (`cmvl0yv6q000ye4yjxs2mggy8`) |

## 1. Livraisons

| PR | Contenu | Migration production |
|---|---|---|
| nizarsakal-ai/planificator#195 — 2A | `subject` normalisé dans le NormalizedInbound (NFC, borne de 512, jamais journalisé) | Aucune |
| nizarsakal-ai/planificator#197 — 2B | Sources, Rules, Bindings ; bornes en base ; déclencheur d'identité ; façade d'administration auditée | `20261125090000_v2_integration_routing_config`, appliquée et contrôlée |
| nizarsakal-ai/planificator#198 — 2C | Router pur, empreinte `rcv1_`, port corps local, décisions idempotentes et immuables | `20261126090000_v2_integration_routing_decisions`, appliquée et contrôlée |
| nizarsakal-ai/planificator#199 — 2D | Shadow matching branché après LOT-1C, parité L1 ↔ Router, table de parité sans PII | `20261127090000_v2_integration_routing_parity`, appliquée et contrôlée |
| nizarsakal-ai/planificator#200 — 2E | Simulateur `simulateRouting` ; amorçage du pilote (script, simulation par défaut) ; ce rapport | Aucune |
| nizarsakal-ai/planificator#222 | Corrections des 5 points de la revue indépendante (§3.3) | Aucune |
| nizarsakal-ai/planificator#225 | Référence de parité indépendante sous l'admission LOT-3 (§3.4) | Aucune |

La PR nizarsakal-ai/planificator#42 a été fermée avec un renvoi vers 2A et 2B, comme le prévoyait le plan.

## 2. Critères de sortie (SPEC §22)

| # | Critère | État | Preuve |
|---|---|---|---|
| 1 | SPEC, plan GO, implémentation, **revue indépendante**, **validation manuelle** | **Partiel** | Revue indépendante faite le 24/11 : **GO sous réserve**, 5 points importants, corrigés par nizarsakal-ai/planificator#222 (§3.3). Validation manuelle à faire. |
| 2 | Sources / Rules / Bindings persistés et validés | Fait | `routing-config.pg`, `inbound-source.repository.pg` : unicités, un Binding actif par Source, isolation tenant, bornes, déclencheur d'identité, audit sans valeur |
| 3 | Outcomes métier corrects ; idempotence §9.2 | Fait | `tenant-router.test` (les cinq outcomes, ambiguïté sans attribution) ; `routing-decision.pg` (rejeu, `Promise.all` à 8 appels, outcome jamais remplacé, `DUPLICATE` interdit en base) |
| 4 | `SUBJECT_KEYWORD` / `BODY_KEYWORD` (§11–§12) ; LOT-2A | Fait | Sous-chaîne NFC, objet absent ⇒ ne matche pas ; `UnavailableLocalBodyPort` (I3), aucune I/O distante ; 2A livrée |
| 5 | Empreinte stable et testée (§13.4) | Fait | Stabilité sur N exécutions, ordre indifférent, sensibilité à chaque changement fonctionnel, `companyId` en préambule |
| 6 | Shadow : zéro effet de bord, projection §14.5, Envelope `NORMALIZED`, critères §14.8 | **Partiel** | Effets de bord, projection et Envelope : prouvés par les tests (non-régression de la synchronisation Gmail, `routing-parity.pg`, `consultations-admission-prototype.pg` 14/14). Le seuil « divergences non expliquées = 0 » se mesure avec la référence indépendante depuis le 24/11 (§3.4). |
| 7 | Barrière LOT-3 | Fait | Test d'architecture : aucune admission, aucun brouillon ni transition d'Envelope dans `router/**`, `shadow/**`, `simulator/**` ; décompte des brouillons inchangé en PG |
| 8 | Simulateur (§20.4) | Fait | `simulateRouting` : ADMIN/SUPER_ADMIN de la société de session ; aucune écriture, vérifiée en PG (décisions, audit, Envelopes, NormalizedInbound, parité inchangés) |
| 9 | Flags fail-closed, rollback | Fait (tests) | Strictement `"true"`, défaut OFF, foundation requise, allowlist ; flag coupé ⇒ rien n'est lu ni écrit. Rollback en production à démontrer pendant le pilote (§3, étape 6). |
| 10 | Observabilité sans valeur brute (§16) | Fait | Journaux via la redaction LOT-1C ; tests : aucun email, objet, identifiant externe ni valeur de règle ; identifiant externe haché dans la table de parité |
| 11 | Tests §20 verts | Fait | `test:integration:persistence:pg` 68/68 ; `test:integration` 213/214 (seul échec : `event-sync.ts` et `quick-event.ts`, déjà présent sur `main`) ; `test:integration:mail-shadow` 56/56 |
| 12 | Aucun LOT-3 dans le diff | Fait | Aucun code d'admission |
| 13 | Booking intact, pas de second poll | Fait | Aucun fichier Booking modifié ; non-régression : un seul poll par synchronisation |

## 3. Reste à faire avant MODULE CLOSED (pilote GALYA EVENTS)

### 3.1 État au 24/11/2026

| Étape | État |
|---|---|
| 1-2. Amorçage | Fait le 22/11 (script, compte ADMIN de GALYA EVENTS). 9 Sources actives : les 3 partenaires initiaux et 6 ajoutés le même jour, chacune avec sa règle d'identité et son Binding `consultations`, toutes auditées. Un partenaire sans domaine ni email (doublon apparent `lamanufacturedesbaches.fr`) est écarté (`NO_VALID_IDENTITY`) : à désactiver côté Acquisition. |
| 3. Simulation | Non faite : exige l'accès à la base de production. Remplacée par l'observation réelle du shadow. |
| 4-5. Activation | Faite le 22/11, hors de cette session : les flags LOT-1C et `INTEGRATION_ROUTING_*` sont posés en Production pour GALYA EVENTS seulement. |
| 6. Observation | En cours, avec la référence indépendante depuis le 24/11 (§3.4). Bilan programmé le 01/12/2026. |

**Premiers résultats** (au 24/11) : 8 messages normalisés, 8 décisions, 7 observations.
- 5 `PARITY_LEGACY_ONLY` non expliquées, toutes du 23/11 entre 11 h et 12 h UTC. Cause établie : l'ancien mapper du shadow prenait l'en-tête `From` brut pour expéditeur, d'où le domaine `lauralu.fr>`, qui ne correspond à aucune règle. Défaut corrigé par nizarsakal-ai/planificator#203, fusionnée le 23/11 à 13:32 UTC, qui applique la même normalisation que le legacy.
- 1 `PARITY_MATCH`, après le correctif, et 1 `PARITY_REJECT`.

Les observations étant immuables, ces 5 lignes restent en table. **Le critère §14.8 se mesure à partir du 23/11/2026 13:32 UTC.**

**LOT-3 actif.** Livré hors de ce lot (nizarsakal-ai/planificator#201, #204), `INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED` est posé en Production depuis le 23/11. Pour GALYA EVENTS, une décision `MATCH` du Router n'est donc plus seulement observée. Une divergence peut désormais avoir un effet réel, à surveiller par le porteur du LOT-3.

**Constat du 24/11.**
- Sous l'admission LOT-3, la synchronisation coupait le shadow LOT-1C (`routerAdmits`) : **aucune observation de parité n'était écrite depuis l'activation du LOT-3**.
- Même active, la comparaison aurait opposé le Router à son propre résultat, ce qui rendait le critère §14.8 impossible à prouver.
- Corrigé par la référence indépendante (§3.4).

### 3.4 Référence de parité indépendante sous LOT-3 (24/11/2026)

nizarsakal-ai/planificator#225, déployée le 24/11 (déploiement de production créé à 16:04 UTC).

**Fonctionnement**
- Pour chaque message passé par l'admission LOT-3, les règles historiques d'éligibilité du registre partenaires sont rejouées en **lecture seule** : email exact, domaine, « email exact requis ».
- Le résultat est comparé à la décision du Router, qui réutilise sa décision existante.
- La décision LOT-3 n'est jamais modifiée.
- Lecture lancée seulement si le shadow matching est actif pour la société, en parallèle de la décision.
- Un budget unique de 2 s couvre référence, routage et écriture de l'observation ; au-delà, l'admission rend la main.

**Recette en production** (journaux Vercel, lecture seule)
- Première observation enregistrée le 24/11 à 17:00 UTC : `legacyOutcome = REJECT`, `routerOutcome = NO_MATCH`, `PARITY_REJECT`, `unexplainedDivergence = false`.
- Les relectures horaires du même message réutilisent la décision (`idempotentReuse`) sans nouvelle observation (`recorded = false`).
- Aucune divergence non expliquée, aucune erreur d'exécution.

**Mesure du critère §14.8**
- Base : observations rattachées aux enveloppes `consultations-gmail-v1:` postérieures au 24/11 16:04 UTC.
- Les observations hors LOT-3, entre le 23/11 13:32 et le 24/11 16:04, sont comptées à part.

**Critères du bilan**

| # | Critère |
|---|---|
| B1 | Divergences non expliquées = 0 |
| B2 | Décisions LOT-3 sans observation = 0 |
| B3 | ≤ 10 % de `PARITY_UNCOMPARABLE`, chaque cas justifié |
| B4 | `PARITY_ERROR` = 0 |
| B5 | Au moins 10 observations comparables ; sinon, prolonger l'observation |
| B6 | Aucune erreur de synchronisation imputable |

Avec environ un nouveau message par jour, B5 risque de ne pas être atteint le 01/12.

**Limites connues**
- `EXPLAINED_MATCH_NO_DRAFT` reste posé sur chaque accord, alors que sous LOT-3 un accord crée un brouillon. C'est sans effet sur B1 ; changer ce libellé demanderait une migration.
- Un partenaire historique hors pipeline Consultations ressortirait en `PARITY_LEGACY_ONLY` : c'est attendu, à justifier au cas par cas.

### 3.3 Revue indépendante (24/11/2026) — GO sous réserve

Relecture en lecture seule d'`origin/main` par un relecteur distinct de l'auteur, sans accès à ses conclusions. Aucun point bloquant. Les points 1 à 3 ont été vérifiés dans le code par l'auteur. **Les cinq points importants sont corrigés par nizarsakal-ai/planificator#222** (fusionnée le 24/11, sans migration).

| # | Point important | Effet | À corriger avant |
|---|---|---|---|
| 1 | `EXPLAINED_SUBJECT_ABSENT` / `EXPLAINED_BODY_UNAVAILABLE` sont posés dès qu'une règle de ce type existe dans la société, sans lien avec la Source en cause, et ils « expliquent » aussi un `ROUTER_ONLY` (`routing-parity.ts`). | Le critère §14.8 pourrait être atteint à tort. Latent aujourd'hui : le pilote n'a que des règles d'identité. | Toute interprétation de la parité avec des règles mots-clés |
| 2 | Après l'échéance du budget, `projectMailShadowAfterLegacy` sort sans aucune observation (`mail-shadow-hook.ts`), contrairement au plan §7 (`PARITY_UNCOMPARABLE`). | Comptages de parité sous-estimés, sans signal. | Le bilan de clôture |
| 3 | Aucun délai maximal sur `router.route()` : l'échéance n'est vérifiée qu'avant le routage, alors que la lecture de la configuration passe par une transaction `RepeatableRead`. | Une base lente peut allonger la synchronisation Gmail legacy. | Maintien du shadow en production |
| 4 | Le rejeu de l'amorçage se fait sur le nom affiché : une Source restée désactivée après un échec partiel n'est jamais complétée. | Partenaires manquants, donc faux `LEGACY_ONLY`. Sans effet sur l'amorçage du 22/11 : aucun échec partiel. | Prochain rejeu du script |
| 5 | L'audit est écrit après la mutation, hors transaction (`routing-config-admin.service.ts`). | Mutation possible sans trace, doublon si l'appelant relance. | Ouverture de l'administration au-delà du script |

Points mineurs, à suivre à part :
- contrôle d'identité SQL contournable par deux écritures SQL directes concurrentes (les services verrouillent) ;
- casse des emails et domaines non imposée en base ;
- façade d'administration partielle (ni modification ni suppression) ;
- unicité de la parité figée sur la première classe L1.

À vérifier :
- le LOT-3 écrit ses décisions faisant autorité dans `integration_routing_decisions`, sans colonne de mode, ce qui mélange les comptages §16 ;
- l'amorçage ne filtre pas `connector = GMAIL`.

### 3.2 Procédure initiale (pour mémoire)

Ordre prévu au 22/11, chaque étape avec l'accord de Nizar :

1. **Amorçage en simulation.** Lancer `npm run db:seed:routing-pilot -- --companyId=cmvl0yv6q000ye4yjxs2mggy8 --actorUserId=<ADMIN GALYA>`. La sortie donne le plan sous forme de compteurs et de noms de partenaires, jamais de valeurs.
2. **Amorçage réel.** Même commande avec `--apply`. Rejouable sans doublon ; chaque création est auditée.
3. **Simulation** de quelques messages connus avec `simulateRouting`, pour vérifier la configuration.
4. **Activation du shadow LOT-1C** pour le pilote : `INTEGRATION_PLATFORM_FOUNDATION_ENABLED`, `INTEGRATION_MAIL_SHADOW_ENABLED`, `INTEGRATION_MAIL_SHADOW_COMPANY_ALLOWLIST`.
5. **Activation du shadow matching** : `INTEGRATION_ROUTING_ENABLED`, `INTEGRATION_ROUTING_SHADOW_ENABLED`, `INTEGRATION_ROUTING_COMPANY_ALLOWLIST`.
6. **Observation** sur une période convenue, puis **rollback** démontré (couper `INTEGRATION_ROUTING_ENABLED` ⇒ plus aucune décision ni observation, legacy inchangé).
7. **Revue indépendante** et **validation manuelle**, puis passage du statut à CLOSED.

Requête de suivi de la parité (lecture seule, aucune valeur métier) :

```sql
SELECT "parityOutcome", "explainedCodes", "comparisonCode", count(*)
FROM integration_routing_parity_observations
WHERE "companyId" = 'cmvl0yv6q000ye4yjxs2mggy8' AND "observedAt" > '2026-11-23 13:32:55'
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

Une divergence est **non expliquée** si `parityOutcome` vaut `PARITY_LEGACY_ONLY` ou `PARITY_ROUTER_ONLY` et qu'aucun code `EXPLAINED_*` autre que `EXPLAINED_MATCH_NO_DRAFT` n'est présent. Le critère §14.8 exige zéro divergence de ce type.

## 4. Rollback

**Correction du 24/11 :** sur Vercel, une variable d'environnement modifiée ne s'applique qu'au déploiement suivant. Chaque geste ci-dessous exige donc un **redéploiement** (ou la relance du déploiement courant). La version précédente de ce paragraphe disait « sans redéploiement » : c'était inexact.

| Gravité | Geste | Effet |
|---|---|---|
| Comparaison de parité gênante | Retirer `INTEGRATION_ROUTING_SHADOW_ENABLED`, puis redéployer | Plus aucune lecture de référence ni observation ; décisions et admission LOT-3 inchangées |
| Doute sur l'admission LOT-3 | Retirer `INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED`, puis redéployer | Retour au chemin legacy ; la comparaison s'arrête aussi |
| Arrêt complet du Router | Retirer `INTEGRATION_ROUTING_ENABLED` ou `INTEGRATION_PLATFORM_FOUNDATION_ENABLED`, puis redéployer | Plus aucune décision ni observation, **et l'admission LOT-3 s'arrête** (même allowlist et même flag) |

Décisions, observations et configuration sont conservées. Aucune migration destructive. Envelopes inchangées.

## 5. Points notés pendant le lot

- Le build Vercel tombait parfois en manque de mémoire (sur `main` avant ce lot, puis sur la #198). `experimental.webpackMemoryOptimizations` est activé depuis la #198.
- La purge RGPD (LOT-8D) a tourné pour la première fois le 23/11 à 3 h 15 UTC, sans erreur (1,82 s). Elle ne journalise pas ses compteurs quand tout va bien : une ligne de journal avec les deux compteurs rendrait le suivi vérifiable.
- La rétention Neon (PITR) n'est que de 6 h. La décision de Nizar reste en attente : offre payante ou copie quotidienne.
