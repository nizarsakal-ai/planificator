# Runbook — limites de débit des connexions réelles

PLAN-INTEGRATION-PLATFORM-001, LOT-8D. Applique la SECURITY-SPEC §25 (gate 2 du plan LOT-8).

Les compteurs sont lus en base (états OAuth, versions de secret, journal d'audit du coffre, journal des synchronisations). Les limites valent donc pour toutes les instances serverless, sans compteur en mémoire. Les valeurs sont dans `src/lib/integration/connectors/live/live-rate-limits.ts` et `LIVE_SYNC_COOLDOWN_MS`.

| Opération | Limite | Effet d'un dépassement |
|---|---|---|
| Démarrage OAuth (Google Agenda) | 5 par utilisateur et par 10 minutes ; 20 par société et par heure | Refus avec message ; aucun état créé |
| Enregistrement d'identifiants (saisie ou retour OAuth) | 5 versions de secret par connexion et par 10 minutes | Refus avec message ; aucune version créée |
| Refus répétés du service (401/403) | 3 en 15 minutes | Verrou de 15 minutes après le dernier refus ; aucune version créée, aucun appel au service. La clé active éventuelle reste en service. |
| Synchronisation réelle | 1 par minute et par connecteur, échecs compris | Refus sans journal ni appel au service |
| Résolution de secret, rafraîchissement OAuth | 1 par synchronisation, rafraîchissement sérialisé par connexion | Découle de la ligne précédente |
| Retour OAuth | 1 par état (usage unique, 10 minutes) | Lien refusé |

Côté fournisseur : une réponse 429 arrête la synchronisation (`RATE_LIMITED`), sans relance automatique. Shopify est ralenti d'une seconde entre deux requêtes quand son seau dépasse 75 %.

## Modifier une valeur

Changer la constante, mettre à jour ce tableau et les tests (`tests/integration/connectors/live/pg/rate-limits.pg.test.ts`), puis livrer par PR. Aucune variable d'environnement : une limite ne se désactive pas en production.
