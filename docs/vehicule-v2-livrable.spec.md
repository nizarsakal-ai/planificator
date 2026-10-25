# Véhicule V2 — kilométrage et entretien

Date : 24 octobre 2026. Autorité Produit : utilisateur, périmètre et autonomie confirmés dans le chat. Architecture/implémentation : Codex ; revue indépendante avant fusion. État : implémentation, aucune clôture ni autorisation de production.

## Périmètre

Reprendre le domaine et les cinq API de la PR #75, intégrer main, fournir le parcours utilisateur des relevés, trajets et corrections, puis le suivi des vidanges et autres entretiens. Préserver le parc V1, ses affectations et son historique. Le travail multi-entreprise non validé d'une autre copie locale reste indépendant.

## Architecture et décisions

Services transactionnels = autorité métier ; composants = formulaires et présentation. La session serveur définit toujours l'entreprise. Les autorisations sont relues en base. Les droits kilométrage existants sont conservés : administrateurs pour relevés/corrections, chefs d'équipe affectés pour départ/arrivée. L'accès à la page reste conforme à V1.

L'entretien est un agrégat par véhicule, sous le même verrou PostgreSQL que le kilométrage. Deux tables additives : un plan de vidange (intervalle km et/ou mois, révision, auteur courant), un journal d'interventions immuable (vidange/autre entretien, date, compteur, note, auteur, idempotence). Les FK composites incluent l'entreprise. Historique préexistant saisissable, dates futures interdites ; jamais de réécriture silencieuse du compteur depuis une intervention. Révision attendue pour éviter les écrasements de plan concurrents. Les écritures sont réservées aux administrateurs et refusées pour les véhicules archivés.

Les échéances se basent sur la dernière vidange chronologique. Un autre entretien ne remet pas la vidange à zéro. Sans plan : non configuré ; sans vidange : historique à compléter ; sans compteur connu : échéance km inconnue. Date atteinte OU compteur atteint = à faire. Préalerte à 1 000 km OU 30 jours, uniquement si le seuil correspondant est connu. Dates en UTC et addition de mois avec borne au dernier jour du mois. Les intervalles sont saisis par l'utilisateur selon ses véhicules, sans valeur constructeur inventée.

Interface en français, identité du véhicule visible, formulaires étiquetés, états chargement/erreur/succès, historique consultable après archivage. Chargement des journaux à la demande ; pas de requêtes par carte au rendu initial.

Intégration au main `bb7fa1f` : une autorité commune relit sous verrou l'identité User, l'entreprise active et l'appartenance Employee. Le rôle de l'appartenance prime conformément à `resolveCompanyAccess` ; un profil désactivé interdit le repli legacy. Les sessions Super Admin exigent un contexte entreprise explicite côté serveur.

Les compteurs inconnus ne produisent pas de badge « à jour » quand une échéance en kilomètres est configurée. Si une correction place le compteur sous celui de la dernière vidange, un avertissement explicite remplace ce badge. À date d'intervention identique, un ajout ne peut pas faire régresser le compteur ; la dernière vidange est déterminée par date puis compteur décroissants et horodatage d'enregistrement pris après acquisition du verrou.

Les routes `/vehicules` et `/api/trucks` et leurs descendants utilisent NetworkOnly avant les caches PWA génériques, y compris les réponses RSC. Aucun repli hors ligne sur les données d'une session antérieure. Le cache auxiliaire de navigation existant peut encore conserver du HTML, mais ces règles ne le restituent pas pour ces routes. Activation du nouveau service worker à vérifier lors de la phase de déploiement.

## Validation et livraison

- Régression V1 et domaine/API V2.
- Entretien : validation stricte, échéances et dates limites, idempotence, isolation entreprise, droits révoqués, archivage et concurrence.
- Validation Prisma et migrations sur PostgreSQL jetable ; aucun accès aux bases de production.
- Vérification TypeScript ciblée, build et parcours navigateur avec données de test.
- Revue indépendante, documentation d'installation et rapport de preuves.

Livrable = sources et changements reviewables, migrations préparées, tests et limites documentés. Fusion GitHub et mise en service constituent la phase suivante avec l'utilisateur ; le compte Super Admin permet la recette de l'application, pas la fusion Git.
