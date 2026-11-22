# PLAN-INTEGRATION-PLATFORM-001 — LOT-2 Runtime Routing : rapport de clôture

| Champ | Valeur |
|---|---|
| **Statut** | **IMPLÉMENTÉ — NON CLOS.** Restent : revue indépendante, validation manuelle de Nizar, données de parité du pilote (§3) |
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
| 2E (cette PR) | Simulateur `simulateRouting` ; amorçage du pilote (script, simulation par défaut) ; ce rapport | Aucune |

La PR nizarsakal-ai/planificator#42 a été fermée avec un renvoi vers 2A et 2B, comme le prévoyait le plan.

## 2. Critères de sortie (SPEC §22)

| # | Critère | État | Preuve |
|---|---|---|---|
| 1 | SPEC, plan GO, implémentation, **revue indépendante**, **validation manuelle** | **Partiel** | SPEC R1, plan GO et implémentation faits. La revue indépendante et la validation manuelle restent à faire. |
| 2 | Sources / Rules / Bindings persistés et validés | Fait | `routing-config.pg`, `inbound-source.repository.pg` : unicités, un Binding actif par Source, isolation tenant, bornes, déclencheur d'identité, audit sans valeur |
| 3 | Outcomes métier corrects ; idempotence §9.2 | Fait | `tenant-router.test` (les cinq outcomes, ambiguïté sans attribution) ; `routing-decision.pg` (rejeu, `Promise.all` à 8 appels, outcome jamais remplacé, `DUPLICATE` interdit en base) |
| 4 | `SUBJECT_KEYWORD` / `BODY_KEYWORD` (§11–§12) ; LOT-2A | Fait | Sous-chaîne NFC, objet absent ⇒ ne matche pas ; `UnavailableLocalBodyPort` (I3), aucune I/O distante ; 2A livrée |
| 5 | Empreinte stable et testée (§13.4) | Fait | Stabilité sur N exécutions, ordre indifférent, sensibilité à chaque changement fonctionnel, `companyId` en préambule |
| 6 | Shadow : zéro effet de bord, projection §14.5, Envelope `NORMALIZED`, critères §14.8 | **Partiel** | Effets de bord, projection et Envelope : prouvés par les tests (non-régression de la synchronisation Gmail, `routing-parity.pg`). Le seuil « divergences non expliquées = 0 » exige les données réelles du pilote (§3). |
| 7 | Barrière LOT-3 | Fait | Test d'architecture : aucune admission, aucun brouillon ni transition d'Envelope dans `router/**`, `shadow/**`, `simulator/**` ; décompte des brouillons inchangé en PG |
| 8 | Simulateur (§20.4) | Fait | `simulateRouting` : ADMIN/SUPER_ADMIN de la société de session ; aucune écriture, vérifiée en PG (décisions, audit, Envelopes, NormalizedInbound, parité inchangés) |
| 9 | Flags fail-closed, rollback | Fait (tests) | Strictement `"true"`, défaut OFF, foundation requise, allowlist ; flag coupé ⇒ rien n'est lu ni écrit. Rollback en production à démontrer pendant le pilote (§3, étape 6). |
| 10 | Observabilité sans valeur brute (§16) | Fait | Journaux via la redaction LOT-1C ; tests : aucun email, objet, identifiant externe ni valeur de règle ; identifiant externe haché dans la table de parité |
| 11 | Tests §20 verts | Fait | `test:integration:persistence:pg` 68/68 ; `test:integration` 213/214 (seul échec : `event-sync.ts` et `quick-event.ts`, déjà présent sur `main`) ; `test:integration:mail-shadow` 56/56 |
| 12 | Aucun LOT-3 dans le diff | Fait | Aucun code d'admission |
| 13 | Booking intact, pas de second poll | Fait | Aucun fichier Booking modifié ; non-régression : un seul poll par synchronisation |

## 3. Reste à faire avant MODULE CLOSED (pilote GALYA EVENTS)

Rien n'est actif aujourd'hui : aucun flag `INTEGRATION_ROUTING_*` ni LOT-1C n'est posé en production. Ordre proposé, chaque étape avec l'accord de Nizar :

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
WHERE "companyId" = 'cmvl0yv6q000ye4yjxs2mggy8'
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

Une divergence est **non expliquée** si `parityOutcome` vaut `PARITY_LEGACY_ONLY` ou `PARITY_ROUTER_ONLY` et qu'aucun code `EXPLAINED_*` autre que `EXPLAINED_MATCH_NO_DRAFT` n'est présent. Le critère §14.8 exige zéro divergence de ce type.

## 4. Rollback

Retirer `INTEGRATION_ROUTING_ENABLED` ou `INTEGRATION_PLATFORM_FOUNDATION_ENABLED` : plus aucune décision ni observation, legacy seul, sans redéploiement. Décisions, observations et configuration sont conservées. Aucune migration destructive. Envelopes inchangées.

## 5. Points notés pendant le lot

- Le build Vercel tombait parfois en manque de mémoire (sur `main` avant ce lot, puis sur la #198). `experimental.webpackMemoryOptimizations` est activé depuis la #198.
- La rétention Neon (PITR) n'est que de 6 h. La décision de Nizar reste en attente : offre payante ou copie quotidienne.
