# PLAN-INTEGRATION-PLATFORM-001 — LOT-2 Runtime Routing : plan d'implémentation

| Champ | Valeur |
|---|---|
| **Statut** | **PROPOSÉ — en attente du GO de Nizar** (aucune ligne de code LOT-2 avant ce GO) |
| **Date** | 22/11/2026 |
| **SPEC** | `docs/integration-platform-001-lot-2-routing.spec.md` (R1, READY FOR IMPLEMENTATION PLAN) |
| **Jalon** | M2 — Parité Matching |
| **Dépendances** | LOT-1A, LOT-1B1, LOT-1B2, LOT-1C fusionnés sur `main` (constaté) |

Ce plan fige tout ce que la SPEC renvoie au « plan d'implémentation ». Il ne modifie aucune règle de la SPEC.

## 1. Constats sur le dépôt et la production (22/11/2026)

1. **LOT-1C est livré mais éteint en production.** Aucune variable `INTEGRATION_PLATFORM_FOUNDATION_ENABLED`, `INTEGRATION_MAIL_SHADOW_ENABLED` ni `INTEGRATION_MAIL_SHADOW_COMPANY_ALLOWLIST` n'est posée dans Vercel. Aucun `NormalizedInbound` n'est donc produit aujourd'hui. Le shadow matching LOT-2 n'aura de données qu'après activation du shadow LOT-1C pour un tenant pilote (décision §8).
2. **Point d'accroche L1 disponible.** Dans `acquisition-gmail-sync.service.ts`, chaque message passe par `registerIncomingMessage` (résultat `DRAFT_CREATED` ou `REJECTED`), puis par `projectMailShadowAfterLegacy` (LOT-1C). Le résultat L1 et le `NormalizedInbound` sont donc tous deux connus au même endroit, sans second poll.
3. **`subject` volontairement omis** du DTO shadow (`mail-shadow-dto.mapper.ts`, « limiter PII en shadow V1 »). Le contrat LOT-1A l'accepte déjà en optionnel : c'est l'objet de LOT-2A.
4. **Contrat `RoutingDecision`** (LOT-1A) : outcomes `MATCH`, `NO_MATCH`, `NO_ACTIVE_BINDING`, `AMBIGUOUS_SOURCE`, `ERROR`, `DUPLICATE`. `DUPLICATE` ne sera jamais écrit (SPEC §9.2).
5. **Une implémentation partielle existe déjà** : PR nizarsakal-ai/planificator#42 (1er août 2026, jamais fusionnée), soit 32 fichiers. Elle contient la normalisation du `subject` (LOT-2A), les contrats, le dépôt et le service d'écriture des Sources et Rules, sa migration (`20260801220000_add_integration_inbound_sources_rules`) et ses tests. Elle n'a ni Bindings, ni Router, ni `RoutingDecision`, ni shadow. Sa migration est datée avant des migrations déjà appliquées en production : il faudra la redater.
6. **Aucun corps de message matérialisé** par LOT-1C. Le contenu n'est lu que plus tard, par les workers d'acquisition, hors chemin du Router.

## 2. Décisions d'implémentation (à valider avec le GO)

| # | Sujet renvoyé à l'IMPL | Décision proposée |
|---|---|---|
| I1 | Noms des flags (§17) | `INTEGRATION_ROUTING_ENABLED`, `INTEGRATION_ROUTING_COMPANY_ALLOWLIST` (CSV), `INTEGRATION_ROUTING_SHADOW_ENABLED`. Tous exigent aussi `INTEGRATION_PLATFORM_FOUNDATION_ENABLED`. Strictement `"true"` ; défaut OFF ; indépendants des flags LOT-1C. |
| I2 | Hash `routingConfigurationVersion` (§13) | SHA-256 hex du JSON canonique (clés triées, sans espaces) de `{ v: 1, companyId, sources, rules, bindings }`, chaque liste triée par `id`. Champs retenus : exactement ceux du §13.2.3. Préfixe `rcv1_`. |
| I3 | Port corps local (§12) | `LocalMessageBodyPort.read(normalizedInboundId) → { available: false } \| { available: true, text }`. Implémentation V1 unique : `UnavailableLocalBodyPort` (toujours indisponible). `BODY_KEYWORD` ne matche donc jamais en V1 ; divergence `EXPLAINED_BODY_UNAVAILABLE`. Un port lisant un contenu déjà stocké localement exigera un GO séparé (PII). |
| I4 | Cache (§13.3) | **Pas de cache inter-requêtes en V1** (serverless) : snapshot chargé au début de chaque invocation, borné par les limites §15.4. L'invalidation est donc immédiate par construction. |
| I5 | Persistance de la parité (§14, §16) | Table `routing_parity_observations` en ajout seul, sans PII : `companyId`, `normalizedInboundId`, `externalId` haché, `parityBaselineCode`, outcome L1 (classe), outcome Router, `PARITY_*`, codes `EXPLAINED_*`, `routingConfigurationVersion`. Nécessaire pour prouver « divergences non expliquées = 0 » (§14.8). **Ajout par rapport aux quatre tables de la SPEC : à valider.** |
| I6 | `EXPLAINED_MATCH_NO_DRAFT` (§14.6) | Mode « décision contre décision » : la parité compare l'outcome L1 (`DRAFT_CREATED` → Admit, `REJECTED` → Reject) à l'outcome Router, selon la table §14.5. `EXPLAINED_MATCH_NO_DRAFT` est une **annotation** posée sur toute observation où le Router dit `MATCH` (aucun brouillon Platform n'existe en LOT-2). Elle ne remplace jamais l'outcome de parité et n'est jamais comptée comme divergence non expliquée. Aucun brouillon n'est lu ni créé. |
| I7 | Simulateur (§20.4) | Fonction service `simulateRouting(db, { companyId, message, connectionId? })`, en lecture seule : charge la configuration, calcule outcome et hash, ne persiste rien. Aucune exception d'audit en V1. Accès réservé à ADMIN et SUPER_ADMIN de la société de session. Pas d'UI (LOT-6). |
| I8 | Administration de la configuration (§18.3) | Services CRUD Sources, Rules et Bindings, AuthZ ADMIN/SUPER_ADMIN de la société de session, normalisation serveur §6.3, bornes §15.4, audit dans `history_logs` (identifiants seulement, jamais `value` ni `normalizedValue`). Pas d'UI : un script d'amorçage du tenant pilote (dry-run par défaut) traduit la configuration d'éligibilité legacy en Sources et Rules. |
| I9 | Ordre total du snapshot | Tri lexicographique par `id`, puis par `sourceId` en cas d'égalité. |
| I10 | Clé étrangère Binding → Connection (§7) | Clé composite `("connectionId", "companyId")` vers `integration_connections("id", "companyId")`, `ON DELETE RESTRICT`. |

## 3. Découpage en PR (une PR ne démarre qu'après fusion de la précédente)

| PR | Contenu | Migration | Tests de fermeture |
|---|---|---|---|
| **2A** — `subject` (reprise de la #42) | Mapper `mail-shadow-dto.mapper.ts` : `subject` renseigné s'il est déjà dans le message acquis (trim, NFC, aucune balise HTML, 512 caractères au plus, troncature documentée), jamais journalisé. Aucun fetch. | Non | Unitaires : présent, absent, vide, trop long, Unicode ; contrôle statique sans réseau ; logs sans `subject`. |
| **2B** — Configuration (reprise de la #42, complétée des Bindings) | Tables `inbound_sources`, `inbound_source_rules`, `pipeline_bindings` ; contrats Zod ; normalisation §6.3 ; services CRUD avec AuthZ, bornes et audit ; règle « Source active ⇒ au moins une rule IDENTITÉ active » vérifiée par le service et par un déclencheur. | Oui, additive | PG : unicités (un Binding actif par Source), isolation tenant, bornes, déclencheur d'intégrité, audit sans valeur brute. |
| **2C** — Router | Router pur (§10), hash I2, port I3, dépôt `routing_decisions` idempotent (`ON CONFLICT DO NOTHING` puis relecture ; `reused` hors contrat). Aucune transition d'Envelope. | Oui, additive | Unitaires §20.1 complets ; PG : idempotence, `Promise.all` concurrent, Envelope toujours `NORMALIZED`, aucun appel d'admission (contrôle statique). |
| **2D** — Shadow | Appel du Router après `projectMailShadowAfterLegacy`, sous les flags I1, dans le budget du run shadow, best-effort (une erreur n'altère jamais le chemin legacy ni ses statistiques) ; calcul de parité I6 ; table I5 ; journaux redacted. | Oui, additive (I5) | Non-régression §20.3 : aucun brouillon supplémentaire, aucun second poll, statistiques legacy identiques, Booking intact, LOT-1C intact ; kill-switch testé. |
| **2E** — Simulateur et amorçage | `simulateRouting` (I7) ; script d'amorçage du pilote (I8) ; rapport de fermeture §22. | Non | Simulateur sans persistance ; script en dry-run vérifié. |

**Reprise de la PR #42** : 2A et 2B repartent de son code, rebasé sur `main` et revu contre ce plan (flags I1, bornes, audit, déclencheur d'intégrité). Sa migration est redatée après la dernière migration de `main`. La #42 est ensuite fermée, avec un renvoi vers les nouvelles PR. Rien n'est réécrit sans raison.

Chaque migration a son script Neon (`docs/runbooks/neon-<migration>.sql`), testé sur base jetable et appliqué **avant** la fusion, à cause de la garde de schéma du build de production.

## 4. Chemins autorisés

- Nouveaux : `src/lib/integration/sources/**`, `rules/**`, `bindings/**`, `router/**`, `shadow/**`, `simulator/**`.
- Modifiés : `src/lib/acquisition/connector/mail-shadow-dto.mapper.ts` (2A) ; `src/lib/acquisition/connector/mail-shadow-hook.ts` (2D, appel du Router seulement) ; `src/lib/integration/flags/**` (I1) ; `prisma/schema.prisma` et migrations additives ; tests ; `docs/**`.
- Interdits : Review, Conversion, Booking, admission ou brouillon Platform, worker de contenu, CAS d'Envelope, migrations destructives LOT-1B, UI.

## 5. Observabilité (§16)

Un journal par message routé, via l'API de redaction LOT-1C : outcome Router, `PARITY_*`, codes `EXPLAINED_*`, `rulesEvaluated`, `durationMs`, `idempotentReuse`, identifiants opaques. Jamais `subject`, corps, e-mail, `value`, `normalizedValue`. Les compteurs agrégés sont lus dans `routing_parity_observations`.

## 6. Rollback

`INTEGRATION_ROUTING_ENABLED` ou `INTEGRATION_PLATFORM_FOUNDATION_ENABLED` retiré : plus aucune décision, legacy seul, sans redéploiement de code. Décisions et observations conservées. Aucune migration destructive. Envelopes inchangées.

## 7. Risques

| Risque | Parade |
|---|---|
| Ralentir la synchronisation Gmail | Router exécuté dans le budget shadow existant (2 s par run par défaut) ; au-delà, le message n'est pas routé et l'observation est marquée `PARITY_UNCOMPARABLE`. |
| Fuite de PII dans les journaux | Redaction obligatoire et tests statiques ; table de parité sans valeur brute. |
| Divergences massives faute de configuration | Code `EXPLAINED_CONFIG_NOT_SEEDED` ; amorçage du pilote (2E) avant d'interpréter la parité. |
| Confusion avec l'admission | Barrière LOT-3 vérifiée par test statique : aucun import de l'admission ni du brouillon depuis `router/**` ou `shadow/**`. |

## 8. Décisions demandées à Nizar

1. **GO du plan** (I1 à I10), en particulier I5 (table de parité en plus des quatre tables de la SPEC) et I3 (`BODY_KEYWORD` inactif en V1).
2. **Tenant pilote** : GALYA EVENTS (`cmvl0yv6q000ye4yjxs2mggy8`), déjà pilote des lots F et 8.
3. **Activation du shadow LOT-1C** pour ce pilote, une fois 2D livrée : `INTEGRATION_PLATFORM_FOUNDATION_ENABLED`, `INTEGRATION_MAIL_SHADOW_ENABLED` et l'allowlist. Prérequis pour obtenir des données de parité.
