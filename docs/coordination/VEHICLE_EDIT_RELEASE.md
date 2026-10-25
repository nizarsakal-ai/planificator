# Véhicules — modification explicite et validation volontaire

## Demande et comportement livré

Les informations d’un véhicule doivent rester modifiables après leur enregistrement. La saisie d’une date, d’un champ ou la touche Entrée ne doit pas déclencher une validation prématurée. L’utilisateur ouvre « Modifier », complète sa saisie, puis active explicitement « Valider les modifications ». « Annuler » abandonne le brouillon.

Les formulaires concernés utilisent une protection partagée contre la soumission implicite par Entrée. Les boutons de validation sont explicitement identifiés ; les autres actions sont des boutons ordinaires. Un rafraîchissement ne doit pas remplacer silencieusement un brouillon ni contourner les contrôles de concurrence.

## Périmètre fonctionnel

- **Documents** : le contrôle technique et les autres catégories documentaires disposent de « Modifier ». Les métadonnées existantes sont préremplies. Une modification produit une nouvelle version ; le fichier est conservé lorsqu’il n’est pas remplacé. La nouvelle version revient au statut « À vérifier », même si la précédente avait été vérifiée. Les versions antérieures restent consultables.
- **Identité du véhicule** : modification des informations puis validation explicite.
- **Périodicité des vidanges** : « Modifier », « Valider » et « Annuler ». La révision attendue est celle du début de la modification, afin qu’un rafraîchissement ne masque pas un changement concurrent.
- **Interventions d’entretien** : modification avec motif par ajout d’une nouvelle version. L’intervention d’origine n’est jamais réécrite. Seules les versions effectives participent aux échéances ; les versions remplacées et leurs liens documentaires restent conservés. Le compteur courant ne change pas du fait d’une intervention ou de sa correction.
- **Kilométrage** : « Modifier » ouvre le mécanisme de correction auditée existant, avec motif. La valeur d’origine et chaque correction restent dans le journal. La version effective attendue est capturée au début de la modification ; un changement concurrent provoque un conflit explicite.
- **Carburant et coûts, imports d’adresses et tournées** : parcours de modification et validation explicite intégrés dans les limites des états métier autorisés. Les règles d’historique, de consommation des imports et de cohérence des trajets restent applicables.

La modification ne supprime pas les contrôles de rôle, d’entreprise, d’archivage ou de cohérence métier. Une intervention déjà remplacée ne peut pas être corrigée une seconde fois à partir de sa version obsolète.

## Migration de données

La migration additive **63**, `20261025160000_vehicle_maintenance_corrections`, ajoute aux interventions les informations de remplacement et de motif. Une contrainte de référence limite les liens au même véhicule et à la même entreprise ; un index unique empêche deux corrections de remplacer la même version. Les contraintes d’immutabilité existantes restent en place.

Les corrections passent par une transaction verrouillant le véhicule. Les demandes identiques peuvent être rejouées sans créer de doublon. Les projections des échéances excluent les versions remplacées, y compris sur la liste des véhicules.

Aucune restauration Neon, aucun échange de branches et aucune réécriture des migrations historiques ne font partie de cette correction.

## Vérifications effectuées

| Vérification | Résultat |
| --- | --- |
| PostgreSQL local | 21/21 réussies |
| Recontrôle Neon isolé | 9/9 réussies |
| Tests V3 | 144 réussis |
| Tests de pages V3 | 9 réussis |
| Tests V1 | 219 réussis |
| Tests V2 | 178 réussis |
| Vérification TypeScript ciblée véhicules | Réussie |

Le journal du recontrôle Neon est `work/vehicle-edit-pg-neon-recheck.log`, dans l’espace de travail parent du dépôt.

La vérification TypeScript globale présente encore des erreurs préexistantes dans les tests d’acquisition et de réservation (« booking »). Le succès de la vérification ciblée véhicules ne constitue donc pas un succès du typage global du dépôt.

### Essai réel de l’interface en préproduction

Déploiement final de préproduction : **`dpl_Ad2YmrFFJVwNMS7nXQXxMjnpwyPx`**, état **READY**.

Le parcours documentaire a été exécuté dans l’interface :

1. Ouverture de la modification d’un document de version 1 déjà vérifié.
2. Vérification du préremplissage des informations.
3. Saisie et utilisation de la touche Entrée : le formulaire reste ouvert et n’est pas validé implicitement.
4. Validation explicite de la modification.
5. Contrôle de la création de la version 2 au statut `TO_VERIFY`, avec conservation du fichier.

Ce résultat prouve le parcours documentaire décrit ; il ne vaut pas affirmation d’un essai navigateur individuel de chaque état possible de tous les modules.

## Coordination et revue

Le contexte AI Team consulté à **10:59 UTC** indique un contrôleur actuellement limité au dépôt de test. Aucune nouvelle exécution Claude n’est autorisée pour ce dépôt dans ce cadre. Cette livraison ne revendique donc pas de nouvelle revue Claude ; la restriction du contrôleur n’a pas été contournée.

## État de publication

**La préproduction est prête et vérifiée. La publication en production reste à effectuer au moment de la rédaction de ce bilan.**

Le responsable de publication doit compléter cette section avec l’identifiant du déploiement de production, l’application de la migration 63 et les résultats des contrôles après publication. La disponibilité de la préproduction ne doit pas être présentée comme une activation en production.
