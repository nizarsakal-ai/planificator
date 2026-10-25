# Routage privé V3

Le routage V3 utilise GraphHopper 11.1 et un graphe OpenStreetMap de France métropolitaine. Il calcule une estimation entre les points explicitement confirmés, dans leur ordre. Un retour au dépôt doit figurer parmi ces points. Le profil voiture respecte les restrictions de virage importées ; il ne garantit pas les restrictions de hauteur, poids ou accès poids lourds. Le kilométrage réel et les compteurs des véhicules ne sont jamais modifiés par ce calcul.

## Configuration applicative

Variables serveur : `PLANIFICATOR_ROUTING_ENABLED=true`, `PLANIFICATOR_ROUTING_PROVIDER=GRAPHHOPPER`, `PLANIFICATOR_ROUTING_GRAPHHOPPER_URL` (HTTPS), `PLANIFICATOR_ROUTING_GRAPH_VERSION`, et `PLANIFICATOR_ROUTING_TOKEN` (secret serveur, au moins 32 caractères). Aucune de ces variables secrètes ne doit porter le préfixe NEXT_PUBLIC. Le jeton n'apparaît ni dans les URL ni dans le navigateur.

Le cache PostgreSQL sépare les sociétés, les fournisseurs, les points ordonnés et les versions du graphe. Durée : une heure. Une lecture du cache vérifie aussi l'autorisation. Un refus de cadence fournisseur (429) reste une réponse 429 et ne déclenche pas de temporisation globale. Sur absence de cache : admission globale d'une demande par seconde et quota atomique de 60 demandes par société et par heure. Après erreur fournisseur 5xx, temporisation globale de 30 secondes. La transaction se termine avant l'appel réseau. Pas de nouvelle migration : tables cartographiques existantes, historique inchangé à 61 migrations actives.

## Service privé

Java officiel Temurin 21 et JAR GraphHopper 11.1, identifiés par leurs empreintes dans `scripts/routing/manifest.json`. Construire le graphe hors production avec `config.yml`, puis servir les mêmes fichiers via `runtime.yml` en mémoire mappée. Les restrictions de virage et la préparation CH sont activées. Le service doit refuser de démarrer si son graphe manque ou ne correspond pas à la version attendue ; ne jamais lancer l'import sur les fichiers du graphe actif.

Le moteur Docker n'expose que 127.0.0.1:8989 côté hôte. Aucun port administrateur public. Plafond cible : 3,5 Gio de mémoire, heap Java 2 Gio, 1,5 CPU, 128 processus, capacités Linux supprimées et racine du conteneur en lecture seule. Seul le dossier du graphe peut être modifié pour le verrou GraphHopper ; le jeton n'est pas monté dans ce conteneur.

La passerelle Python écoute seulement 127.0.0.1:8992. Caddy termine TLS sur un domaine séparé. La passerelle exige un jeton Bearer comparé en temps constant, n'autorise que `/route` et `/health`, valide les paramètres, limite les demandes à 40 points et la réponse à 100 ko. Deux calculs simultanés au maximum et admission minimale de 0,5 seconde. Les journaux ne contiennent pas les coordonnées ni le jeton.

## Recette avant activation

Vérifier : empreinte du PBF, import réussi, profil car disponible, routes publiques de courte et longue distance, étapes et aller-retour, Corse, points identiques, refus hors couverture, refus sans jeton, rafales, redémarrage et consommation mémoire sous charge. Vérifier ensuite l'API et l'interface authentifiées en préproduction, avec société synthétique et source d'adresses de test. Le build de publication vérifie le projet, la base, les drapeaux et la santé/version du moteur privé ; aucun `migrate deploy` dans le build.

## Exploitation et retour arrière

Avant mise à jour des données, conserver le graphe actif et son manifeste. Construire le nouveau graphe dans un autre répertoire, contrôler son intégrité et exécuter la même recette. Changer le graphe et sa version ensemble ; ne jamais écraser les fichiers d'un moteur en cours de service. Vérifier TLS, santé, mémoire et routes après redémarrage. Les données doivent être reconstruites régulièrement ; l'absence de mise à jour n'est pas un service temps réel et les travaux/fermetures récents ne sont pas garantis.

Pour désactiver rapidement, remettre `PLANIFICATOR_ROUTING_ENABLED=false` puis republier la version validée, ou restaurer le précédent déploiement Vercel. Le moteur privé peut rester arrêté ; géocodage et saisie manuelle continuent de fonctionner. Aucun changement de branche Neon ni restauration de données n'est nécessaire.

Attribution : © OpenStreetMap contributors, https://www.openstreetmap.org/copyright. GraphHopper : Apache License 2.0. Les serveurs publics de démonstration OSRM ne sont pas utilisés en production commerciale.
