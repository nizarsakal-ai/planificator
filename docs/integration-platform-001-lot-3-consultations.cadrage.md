# LOT‑3 — Cadrage de l’admission Consultations

## Point de départ

Le LOT‑2 observe le résultat de Consultations après l’appel à `registerIncomingMessage`. Le premier rejet du pilote GALYA EVENTS concorde avec le routeur. Au dernier contrôle, aucun cas positif n’avait été observé. La sortie du shadow exige encore la recette de parité, la démonstration du retour arrière et la revue de clôture. Ce cadrage prépare le travail local sur données fictives.

## Chemin d’admission proposé

1. Sélectionner l’autorité au point d’entrée Acquisition, pour la société du message. Par défaut, conserver l’autorité historique. En mode admission Platform, le pipeline Consultations devient le seul auteur de la projection métier. Si le nouveau chemin échoue, retourner un échec rejouable, sans appeler l’ancien chemin dans la même tentative.
2. Pour le nouveau chemin, produire l’enveloppe, la normalisation puis la décision avant l’admission. Le dispatcher transmet uniquement une décision `MATCH` persistée, avec une seule source et le pipeline `consultations`. Vérifier en base que décision, source, message normalisé et enveloppe appartiennent à la même société et que leurs liens concordent. Refuser une décision incohérente ou périmée selon la politique de rejeu retenue.
3. Utiliser le contrat versionné `PipelineAdmission` du plan. Il transporte les références de la décision, de la source et du message normalisé, l’identité d’admission, les dates et les références d’artefacts. Le pipeline conserve les données nécessaires aux workers actuels, notamment le partenaire, la boîte et les références de pièces jointes. La correspondance entre source de routage et partenaire Acquisition doit être explicite, stable et vérifiée dans la société. Le nom affiché ne sert pas de clé.
4. Laisser aux chemins existants l’extraction, la revue et la conversion des brouillons. Ne changer ni Booking ni les crons.

## Protection contre les doubles brouillons

| Niveau | Garantie proposée |
|---|---|
| Admission technique | Conserver la clé normative `companyId + pipelineId + normalizedInboundId`. Un rejeu rend l’admission existante. |
| Projection métier | Rattacher les versions normalisées d’une même enveloppe à une projection stable. Une nouvelle version de normalisation ou de règles peut produire une trace distincte, mais réutilise le message métier et son brouillon. |
| Continuité avec Gmail | Réutiliser l’identité existante `companyId + source + sourceMailboxKey + externalMessageId` et le verrou de corrélation Gmail déjà utilisé par Acquisition. Une boîte inconnue ou une correspondance ambiguë bloque l’admission Platform. La projection shadow actuelle transporte l’identifiant externe sans la clé de boîte Acquisition. C’est un prérequis à corriger avant la bascule, sans déduire la boîte du contenu. |
| Transaction | Résoudre ou créer l’admission, le message, les métadonnées nécessaires et son brouillon dans une transaction. Préserver les contraintes d’unicité existantes sur le message et sur `WorksiteImportDraft.acquisitionMessageId`. Les nouveaux liens doivent être protégés par des clés composites incluant la société. Après conflit d’unicité, relire le gagnant et vérifier l’identité avant de retourner ses identifiants. |

Préserver un brouillon déjà créé, son statut et ses modifications. Traiter séparément la promotion d’un message historiquement rejeté sans brouillon, aujourd’hui prévue par Acquisition. Définir le comportement des retries et des traitements déjà en cours pendant une bascule. L’identité partagée et les contraintes restent nécessaires si deux versions du déploiement coexistent.

## Ordre de réalisation et recette locale

1. Figer le contrat, la corrélation boîte/enveloppe et le lien source/partenaire. Tester le refus des références d’une autre société et les identités ambiguës.
2. Implémenter la projection transactionnelle et la tester sur PostgreSQL jetable. Vérifier les doublons sur rejeu, renormalisation, changement de règles, deux appels concurrents, panne avant validation et rejeu après validation. Rejouer aussi un message historique avec brouillon et un rejet devenu éligible.
3. Câbler le choix d’autorité, désactivé par défaut. Prouver qu’une invocation ne peut atteindre qu’un seul écrivain, y compris en cas d’erreur. Tester le chevauchement legacy/Platform, le retour vers legacy et deux boîtes distinctes. Vérifier la continuité pièces jointes, extraction, revue et conversion. Garder l’upload .eml dans son lot et utiliser une fixture pour vérifier l’identité indépendante du fournisseur.
4. Avant toute recette en production, obtenir la clôture du LOT‑2. Avant toute bascule, vérifier en environnement isolé la cardinalité des brouillons, l’absence de doubles traitements, l’isolation par société, la visibilité des erreurs et le retour arrière avec conservation des projections.

Le choix des contraintes supplémentaires et de la migration éventuelle est à justifier après le prototype PostgreSQL. L’invariant à démontrer est **un message métier et au plus un brouillon par identité établie**, y compris après retour vers le chemin historique.

Références dans le dépôt — plan général §§9–11, 13.4–15 et spécification LOT‑2 §14.8.

## Câblage local et retour au flux historique

Le point d’entrée Gmail sélectionne l’autorité une fois par synchronisation. Le LOT‑3 est désactivé par défaut. Il exige le flag `INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED=true` et l’autorisation de routage existante pour la société. Le test configure une connexion d’intégration éligible par boîte Acquisition. La configuration JSON de cette connexion contient `gmailMailboxId` (identifiant de la boîte Acquisition) et `sourcePartners` (liste de couples `sourceId` / `partnerId`). Les identifiants doivent correspondre à la même société. Une liaison manquante ou ambiguë arrête l’admission du message dans le nouveau flux.

Pour revenir au flux historique lors d’une future recette autorisée :

1. Retirer `INTEGRATION_CONSULTATIONS_ADMISSION_ENABLED` ou lui donner la valeur `false` dans l’environnement concerné. Si l’environnement est injecté au déploiement, redéployer la même révision après autorisation. Garder les paramètres shadow LOT‑1C et LOT‑2 en place.
2. Vérifier qu’une nouvelle synchronisation emprunte le flux historique. Un traitement déjà en cours peut finir avec l’autorité qu’il a sélectionnée au départ. Les deux voies partagent l’identité Acquisition et le verrou transactionnel, ce qui protège le brouillon pendant ce chevauchement.
3. Conserver les données, liens et curseurs. Vérifier, sur un rejeu contrôlé en environnement isolé, que le message et le brouillon existants gardent leurs identifiants. En production, observer les résultats des passages habituels sans réinitialiser les curseurs. Les messages précédemment refusés par le LOT‑3 ne sont pas rejoués automatiquement par le retour arrière.

La recette locale a passé 27 tests sur PostgreSQL jetable avec 116 migrations existantes et des messages fictifs. Elle couvre le routeur, la synchronisation Gmail, le rejeu, la concurrence, le retour historique et le shadow existant. Le cas Gmail a vérifié une décision `MATCH`, un seul message et le même brouillon après retour au flux historique. Le câblage n’ajoute aucune migration.
