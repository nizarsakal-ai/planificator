# État vérifié — 25 octobre 2026

Application publiée : dpl_KAi3xB8NvVboLu5oU3B6HwYbrrHW, https://www.galyaevents.fr, état READY. Version applicative locale : 1b5555abd1d7ce6e48a50b0d3d700beb60ad480b sur codex/planificator-v3-final-20261025. La documentation de coordination ajoutée ensuite ne change pas ce code. Dépôt initial sale conservé intact ; pas de fusion ni push distant déclarés. Préproduction validée : dpl_GgHxjVAogSHmKZE7ioqj1p8aUZ7a. Repli applicatif précédent : dpl_25ofpY4jor82HJzSBdvafqjZbbw5.

Neon : 62 migrations actives avec checksums attendus, zéro index/contrainte invalide, branche de production d’origine conservée. Création d’un nouvel instantané refusée par quota ; anciennes sauvegardes conservées, rétention PITR de21600secondes vérifiée et LSN avant/après enregistré dans le dossier final. Aucun rétablissement ou échange de branche effectué pendant cet audit.

Coordination consultée via gateway.py, op=context, réponse09:14:39Z : VPS Hostinger srv2065452, contrôleur limité au dépôt test, execution_enabled=false pour l’orchestration générale, v3_activation=disabled. Ces drapeaux décrivent AI Team, pas les fonctions V3 de l’application publiée. Deux pilotes test SUCCEEDED et deux autres historiques REJECTED/FAILED ; aucune de ces missions ne correspond à Planificateur.

Claude : deux revues initiales puis validation finale statique PASS du code (répertoire de copie VPS v3-release-review-20261025-f32b44d5), validation des origines PASS (v3-release-review-20261025-33c145a2), sorties exit0 conservées. Revues via le lanceur VPS existant avant réception des nouvelles consignes, non présentées comme des missions du contrôleur test. Aucun agent Claude implémenteur ni agent Hermes directement consulté n’est revendiqué. Les documents et statuts de coordination sont accessibles par la passerelle ; cela ne prouve pas une participation active de tous les agents.

Raspberry : aucun diagnostic ni réparation revendiqué ; toute prochaine intervention doit vérifier la disponibilité de nohisac@100.88.103.1 sans modifier les accès ou exposer un service.

Prochaine action : utilisation fonctionnelle et suivi normal de V3. Toute nouvelle mission gouvernée devra respecter les dépôts réellement autorisés par le contrôleur. Aucun secret ni donnée client dans ces documents.

## Dernier contrôle production,25/10/2026 vers09:34UTC

Déploiement et code applicatif inchangés ; quatre onglets chargés, cinq API privées401 sans session, origine étrangère403,62 checksums attendus et zéro structure invalide. Fournisseurs IGN/GraphHopper à nouveau PASS, moteur privé actif sansOOM ni redémarrage, aucun journal error/fatal/warning retourné sur la fenêtre contrôlée et aucune erreur navigateur. Aucun nouveau défaut reproduit, aucune migration ni écriture de recette en production.

Passerelle relue09:27:59UTC. Proposition non exécutante pour planificator refuséeREPOSITORY_NOT_AUTHORIZED ; aucun submit ni contournement. Nouvelle revue Claude non exécutée ; revues finales précédentes réutilisées sur code inchangé. Preuves : outputs/verification-production-v3-20261025-0930/rapport.md dans le workspace de reprise. Cette restriction de revue reste distincte du bon fonctionnement applicatif observé.
