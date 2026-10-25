# Planificateur Véhicules V3 — exploitation et publication

État constaté au démarrage de l’audit final du 25 octobre 2026 : V3 est publiée et active, avec stockage privé Cloudinary, OCR Anthropic, géocodage IGN et routage privé GraphHopper. Déploiement vérifié : `dpl_25ofpY4jor82HJzSBdvafqjZbbw5`, sur https://www.galyaevents.fr. Le livrable final daté conserve les preuves courantes et l’identifiant d’un éventuel déploiement correctif ultérieur.

La version précédente de ce runbook est conservée sous `docs/archive/vehicle-v3-release-avant-audit-final-20261025.md`. Ses mentions « non déployé », 60 migrations et fournisseurs non testés sont historiques ; elles ne décrivent plus la version active.

## Environnements et invariants

Production Vercel : `prj_06FRa8dOdmHA8dD4QSIAqh0pTE8y`. Préproduction : `prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD`. La préproduction utilise exclusivement `V3_STAGING_DATABASE_URL` vers `planificator_staging` ; la variable partagée `DATABASE_URL` n’est pas une preuve d’isolation.

Neon production : projet `square-mountain-05376227`, branche d’origine `br-restless-king-al1y1sqf`, endpoint `ep-plain-voice-alhstww7`, base `neondb`. Historique après publication de ce correctif : **62 migrations actives**, dont les sept migrations V3 initiales et les migrations additives `20261025140000_vehicle_cartography_cache` et `20261025150000_vehicle_tour_skipped_stops`. Les lignes historiques déjà annulées du registre Prisma ne sont pas des migrations actives ; ne pas les modifier.

Aucune restauration, permutation de branche, suppression de table ou migration inverse ne fait partie d’une mise à jour applicative V3. Aucun `prisma db push`. Aucun changement SQL pendant le build. Toute évolution de schéma éventuelle doit être testée séparément sur une copie isolée ; les migrations déjà appliquées restent byte-identiques.

## Configuration serveur

| Fonction | Variables et garde |
|---|---|
| V3 | `PLANIFICATOR_VEHICLES_V3_ENABLED=true` |
| Stockage privé | Triplet `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`, ou `CLOUDINARY_URL` |
| OCR | `ANTHROPIC_API_KEY`, double drapeau `PLANIFICATOR_VEHICLE_OCR_ENABLED=true` et `PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK=true`, consentement explicite par fichier ; modèle allowlisté |
| Géocodage | `PLANIFICATOR_VEHICLE_GEOCODING_ENABLED=true`, `PLANIFICATOR_GEOCODING_PROVIDER=IGN`, `PLANIFICATOR_GEOCODING_IGN_URL=https://data.geopf.fr/geocodage/search` ; consentement avant appel |
| Routage | `PLANIFICATOR_ROUTING_ENABLED=true`, `PLANIFICATOR_ROUTING_PROVIDER=GRAPHHOPPER`, endpoint HTTPS `PLANIFICATOR_ROUTING_GRAPHHOPPER_URL`, `PLANIFICATOR_ROUTING_GRAPH_VERSION`, secret `PLANIFICATOR_ROUTING_TOKEN` |
| Rappels | `CRON_SECRET`, tâche `/api/cron/vehicle-document-reminders` à 06:00 UTC ; notifications internes uniquement |

Les secrets sont des variables serveur, jamais des variables `NEXT_PUBLIC`, des paramètres d’URL, du code ou des pièces jointes de revue. Les variables de branche Vercel doivent être injectées pour la branche réellement déployée. L’archive source et les rapports ne contiennent aucune valeur secrète.

Le routage de démonstration OSRM n’est pas utilisé en production commerciale. Le service IGN d’itinéraires n’est pas le moteur routier de V3. Procédure du service privé, limites voiture/poids lourds, mise à jour du graphe et attribution : `docs/vehicle-v3-private-routing.md`.

## Contrôles avant publication

1. Définir la copie source exacte ; préserver les modifications locales préexistantes. Comparer les fichiers applicatifs aux fichiers testés et conserver leur manifeste.
2. Exécuter les tests V1/V2/V3 et pages, le contrôle TypeScript, puis les suites PostgreSQL affectées. Rejouer l’historique des migrations si le schéma change. Les tests SQL utilisent des données synthétiques et des destinations explicitement gardées ; jamais la base de production.
3. Faire relire le périmètre modifié par Claude via AI Team. Une revue statique ne remplace pas les tests. Si le connecteur de lancement est indisponible, le lanceur AI Team existant du VPS reçoit seulement une copie du code et des tests, sans secrets ni données clients.
4. Publier en préproduction isolée. Vérifier le parcours authentifié, les droits de lecture/écriture, les erreurs et la persistance. Pour les fournisseurs : utiliser les scripts de recette bornés et des fichiers/coordonnées publics ou synthétiques. Ne pas répéter les appels payants sans besoin de vérification.
5. Le build de production doit refuser un mauvais projet/environnement, un mauvais hôte/base Neon, une migration active inattendue, un index ou une contrainte invalide, une configuration requise absente ou une version de graphe privé inattendue. Il ne lance aucune migration.
6. Après READY : vérifier les alias, la page authentifiée et les gardes de l’API. Vérifier la santé du fournisseur et les journaux disponibles. Ne pas déduire d’un HTTP 200 public que les parcours privés sont valides.

Le premier lot de fournisseurs réels a été testé et publié pendant cette reprise globale ; ses rapports datés sont conservés dans les livrables. Les chiffres exacts du nouvel audit final sont consignés dans son rapport, sans recycler un ancien nombre de tests comme preuve actuelle.

## Droits et parcours

- Administrateur effectif de l’entreprise : documents, dépenses, imports, préparation et gestion des tournées. Contexte d’entreprise d’un super-administrateur issu de la session serveur.
- Chef de l’équipe actuellement affectée : documents opérationnels autorisés et lecture des coûts/tournées selon les gardes ; carte grise et rubriques administratives refusées. Les opérations de départ/arrivée/étape autorisées par les règles du journal V2 restent possibles ; cela ne lui donne pas la création de documents, dépenses ou imports.
- Employé/chauffeur/client sans appartenance habilitée : accès V3 refusé. Les droits sont relus côté serveur et dans les transactions, pas seulement cachés dans l’interface.

Une étape en cours peut être signalée « Non visitée » avec un motif obligatoire, un auteur et une date ; elle ne reçoit aucune date de visite effectuée. La clôture exige un résultat pour chaque étape et un compteur réel d’arrivée.

Les contrôles d’origine mutante exigent un véritable en-tête `Origin` correspondant exactement au protocole, à l’hôte et au port servis. Les origines mobiles éventuelles sont explicitement autorisées par `PLANIFICATOR_TRUSTED_ORIGINS`, sans correspondance approximative par hôte.

Les imports restent des brouillons jusqu’à vérification et confirmation des adresses. Leur approbation ne crée pas automatiquement de chantier ni de tournée. La consommation d’un import par une tournée est atomique. Une estimation de route ne devient jamais un compteur réel.

Les coûts par période et par trajet sont des projections séparées : une imputation de frais à un trajet n’est pas ajoutée une seconde fois au total du véhicule. Les kilomètres proviennent du journal réel ; les achats de carburant ne sont pas une consommation réelle. Une couverture partielle est explicitement signalée.

## Repli et exploitation

Retour applicatif : restaurer le dernier déploiement Vercel validé ou désactiver le drapeau concerné et republier. Le prédécesseur du routage privé est `dpl_HBWrVaCGJcZ3MYraUvKqKxXbossd`. Conserver l’historique de déploiement dans le rapport final.

Le drapeau OFF ne supprime ni les données, ni les objets Cloudinary, ni les triggers SQL. Les tournées en cours liées au journal V2 nécessitent une reprise cohérente par V3 ; ne pas supprimer leurs gardes à chaud. Une erreur de migration reste un incident distinct à diagnostiquer ; aucune reprise SQL automatique ou destructive n’est prescrite ici.

Les documents et sources restent privés et versionnés. Les objets de recette fournisseur sont supprimés seulement par leurs identifiants exacts, jamais par un effacement de dossier. Les rappels sont internes et dédupliqués. Le graphe OSM doit être reconstruit régulièrement, séparément du graphe actif, puis vérifié et publié avec sa nouvelle version.
