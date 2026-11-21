# PLAN-INTEGRATION-PLATFORM-001 — LOT-8D : conditions d'exploitation des connexions réelles (plan LOT-8 §7)

| Champ | Valeur |
|---|---|
| **Statut** | En cours — 22/11/2026 |
| **Contexte** | 8A, 8B et 8C sont en production. La connexion réelle (`CONNECTOR_LIVE_ENABLED`) a été activée le 22/11/2026 sur décision explicite de Nizar, avant que les quatre conditions du §7 soient remplies. Ce lot les régularise. |
| **Normes** | SECURITY-SPEC §6, §16, §19, §25, §28 |

## État des quatre conditions

| # | Condition (plan LOT-8 §7) | État | Reste à faire |
|---|---|---|---|
| 1 | KEK production et préproduction posées et distinctes ; déchiffrement refusé dans un autre environnement | **Partiellement prouvé.** Les deux KEK sont posées (Vercel). L'environnement fait partie de l'AAD : un chiffré de préproduction ne s'ouvre pas en production (`tests/integration/secrets/envelope.test.ts`, cas « AAD figé »). | Prouver que les deux valeurs diffèrent, sans les lire. Le geste touche aux secrets : il est confié à Codex (comparaison d'empreintes, rapport « égales » ou « différentes » seulement). |
| 2 | Limites de débit fixées ; procédure de rotation de KEK écrite | **Fait** (PR de ce lot). Limites dans `src/lib/integration/connectors/live/live-rate-limits.ts`, valeurs dans `docs/runbooks/INTEGRATION-RATE-LIMITS.md`. La rotation de KEK est écrite dans `docs/runbooks/INTEGRATION-KEK.md` §3. | — |
| 3 | Restauration de base testée (§19) | **À faire.** | Restaurer une branche Neon à un instant passé (projet `planificator`) et vérifier les contrôles post-restauration ci-dessous. Bloquant : le projet a atteint sa limite de branches. Il faut libérer une branche (décision de Nizar) ou passer à une offre supérieure. |
| 4 | RGPD des données personnelles en zone de transit | **À décider par Nizar.** | Valider la fiche de traitement ci-dessous. La purge à l'échéance demande ensuite une PR dédiée : la zone de transit interdit aujourd'hui toute suppression. |

## Condition 3 — contrôles après une restauration de test

À exécuter sur la branche restaurée, jamais sur `production` :

```sql
-- Aucune version révoquée ou retirée n'est redevenue active.
SELECT status, count(*) FROM integration_credential_versions GROUP BY status;
-- Au plus une version ACTIVE par handle (index partiel).
SELECT "companyId", "credentialsRef", count(*) FROM integration_credential_versions WHERE status = 'ACTIVE' GROUP BY 1, 2 HAVING count(*) > 1;
-- Journal d'audit présent et cohérent avec les révocations.
SELECT action, count(*) FROM integration_secret_audit_logs GROUP BY action;
-- Connexions : leurs états sont restaurés tels quels, sans réactivation automatique.
SELECT "connectorType", status, "credentialStatus" FROM integration_connections ORDER BY 1;
```

Attendu : aucune ligne pour le deuxième contrôle ; les versions `REVOKED` restent `REVOKED`. La KEK n'est pas dans la base : une branche restaurée ne déchiffre que dans un environnement qui porte la même KEK (§19).

## Condition 4 — fiche de traitement proposée (à valider)

| Rubrique | Proposition |
|---|---|
| Données | Shopify : nom, prénom, e-mail et état du compte des clients ; commandes **sans** donnée personnelle. Mailchimp : e-mail et statut de consentement des membres d'une audience. Google Agenda : titre, horaires, lieu des événements de l'agenda principal (sans participant). Slack : noms de canaux publics. |
| Finalité | Préparer l'intégration future des clients et commandes dans Planificator (lot I). Aucune exploitation commerciale en l'état. |
| Base légale | Intérêt légitime de GALYA EVENTS (gestion de sa propre clientèle), sous réserve de validation. |
| Accès | ADMIN et SUPER_ADMIN de la société pilote, aperçu en lecture seule. |
| Durée | **12 mois** après la dernière synchronisation de l'élément, puis purge. Valeur à confirmer. |
| Sécurité | Identifiants chiffrés (coffre PLATFORM_ENCRYPTED) ; zone de transit isolée des tables métier ; lecture seule chez les fournisseurs. |
| Droits des personnes | Une demande d'effacement est traitée par la purge ciblée de l'élément (à livrer avec la purge). |

**Secrets révoqués (§28)** : proposition de conservation de 90 jours après révocation, puis destruction cryptographique de la DEK (statut `DESTROYED`), journal d'audit conservé.
