# RH — association aux fiches employés et ouverture progressive

Associer Employés/Documents RH et réutiliser les informations existantes. Principes de parcours : onglets RH cohérents, action d'ajout explicite et rattachement au collaborateur. Aucune donnée du personnel importée.

## Périmètre
Les fiches Employee existantes restent l'unique source des identifiants et noms. Accès Documents RH depuis une fiche active, uniquement pour une personne ayant READ RH confirmé côté serveur. Vue globale et dépôts en lot conservés. employeeId validé par schéma, capacité READ et appartenance active à la société revérifiées dans le service ; filtre et pagination appliqués en base, jamais simple filtre de pages déjà chargées. Le parcours salarié ne peut sélectionner un autre bénéficiaire. Préselection explicite du salarié pour l'import ; le service revérifie toujours sa société et son état lors des commandes. Pas de nouvelle migration, copie de profil ou extension des droits de fiche Employé.

## Ouverture progressive
HR_DOCUMENTS_ENABLED autorise le module de gestion. Nouveau verrou HR_DOCUMENT_EMPLOYEE_PORTAL_ENABLED : absent/false par défaut, ferme la page Mes documents, sa navigation et toutes les API RH aux comptes sans habilitation opérateur explicite. Le mode salarié déjà développé reste disponible uniquement après activation distincte de ce verrou. Aucun héritage des droits ADMIN. Cette protection répond au refus de promotion de la première configuration, qui ouvrait aussi le portail salarié alors que la recette PDF Google complète n'est pas qualifiée. HR_DOCUMENT_MAIL_ENABLED reste false.

## Critères
Pas de lien RH sans READ ; sélection étrangère ou inactive refusée ; changement de société ne conserve pas d'accès ; pagination bornée au salarié ; import cible modifiée revalidé ; portail absent/false fermé aux non-opérateurs, même via URL/API directe. Module global off ne consulte pas la base. Les autres onglets des fiches et les routes RH existantes sont préservés.

La recette réelle acquise vérifie uniquement connexion opérateur, racine Drive privée distincte et compte inchangé. Les parcours PDF complets sont testés localement avec Google simulé. Ni paie/DSN ni remise officielle ou conservation durable qualifiée ajoutées par ce lot.
