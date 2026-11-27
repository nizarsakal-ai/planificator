# LOT-5 — Recette et plan de mise en production

## Périmètre du candidat

L’import .eml utilise la session de l’administrateur et sa société effective. Le champ From sert au routage. Les brouillons UPLOAD requièrent une revue humaine. L’import est soumis à `INTEGRATION_EML_UPLOAD_ENABLED` et à la liste des sociétés autorisées pour le routage.

La route présentée à la revue renvoie HTTP 422 pour un .eml avec pièce jointe. La recette a utilisé une copie Next.js locale avec l’option d’admission des pièces explicitement passée par la route de cette copie. Elle qualifie le parcours métier et le stockage privé, sans constituer une activation de la route livrée.

## Preuves vérifiées

| Contrôle | Résultat |
| --- | --- |
| Session réelle NextAuth en local avec un administrateur fictif | Connexion HTTP 302, session HTTP 200, société et rôle attendus |
| Requête sans session, puis avec la session | HTTP 401, puis HTTP 201 |
| PostgreSQL jetable | Brouillon créé, octets source persistés, puis libérés après passage de la pièce à STORED |
| Cloudinary de test hjnpvnf7 | Stockage privé puis relecture signée. SHA-256 confirmé sur les 44 octets |
| Réimport | HTTP 200, même brouillon et une seule pièce en base |
| Candidat assemblé sur main 0388a4a | 119 migrations appliquées sur une nouvelle base jetable, deux scénarios PostgreSQL réussis. Vérification TypeScript réussie |
| Tests unitaires ciblés sur le candidat | 108/111. Les trois échecs du worker de décision automatique se reproduisent à l’identique sur main. La suite de ce worker passe 30/30 en figeant l’horloge de ses données fictives, sans modification du code produit. |

Les journaux bruts sont joints au dossier de livraison. Le contrôle Next.js a exercé les points d’entrée HTTP, sans recette visuelle. Aucun test du déploiement hébergé n’a été effectué.

## Ordre des opérations après accord explicite

1. Relire le candidat, obtenir les contrôles GitHub requis et refaire la recette sur une préproduction séparée de la production. Confirmer la base, le compte Cloudinary, la connexion UPLOAD de la société pilote et la limite de taille de requête effective. Vérifier que les imports non autorisés sont refusés avant lecture.
2. Garder `INTEGRATION_EML_UPLOAD_ENABLED` absent ou désactivé au premier déploiement. Confirmer en lecture seule l’état des deux migrations et le rôle applicatif.
3. Après accord de migration, utiliser la connexion directe du propriétaire et suivre [la procédure PostgreSQL](DB-APP-ROLE.md#étapes-staging-dabord-puis-production). Les deux migrations à appliquer dans l’ordre sont `20261128090000_v2_acquisition_upload_source` et `20261129090000_v2_acquisition_attachment_upload_source`. Vérifier les entrées dans `_prisma_migrations` et les droits applicatifs sur la nouvelle table. La garde de schéma Vercel vérifie l’état de la base sans appliquer les migrations.
4. Après accord de fusion et de mise en production, vérifier la version servie, le refus de l’import quand le drapeau est coupé et la continuité de Gmail. Une activation ultérieure du texte doit être limitée à la société pilote et soumise à validation distincte.
5. Avant de proposer l’ouverture aux pièces jointes, faire valider une politique de rétention des octets restant en base en cas d’échec définitif. Qualifier le traitement asynchrone en préproduction, notamment les reprises, les collisions et les issues indéterminées. L’ouverture nécessite un raccordement distinct de la route avec un mécanisme de désactivation et une validation explicite.

## Retour arrière

Couper le drapeau d’import et vérifier le refus de nouvelles requêtes. Si l’environnement fige les variables par déploiement, confirmer que le déploiement servi applique cette configuration. Rétablir la version précédente si le service est dégradé. Conserver les migrations additives, les brouillons et les objets privés. Recenser les traitements en cours et les pièces à réconcilier avant toute reprise ou purge. Vérifier le parcours Gmail après le retour arrière.
