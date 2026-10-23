# Personnel dans plusieurs entreprises — RCTF

**Rôle :** ingénieur applicatif responsable de l'identité et de l'isolation des entreprises.

**Contexte :** `createEmploye` refusait tout e-mail déjà présent dans `users`. La contrainte `employees.userId` imposait également une seule fiche employé par compte. Un salarié Noiza ne pouvait donc pas être ajouté à Galya avec son adresse habituelle.

**Tâche :** conserver une identité de connexion (e-mail et mot de passe) et créer une fiche employé distincte par entreprise. Un employé peut changer d'entreprise active sans perdre ses autres rattachements. Chaque fiche porte son rôle et son état actif. Les historiques restent attachés aux mêmes identifiants.

**Format de livraison :** code, migration Prisma et tests de non-régression ; proposition en brouillon, sans fusion ni mise en production.

## Comportement livré

- Création d'employé : réutilisation de l'identité existante, sans modifier son mot de passe, son rôle principal ou son entreprise principale. Refus d'un doublon actif dans la même entreprise. Réactivation de la fiche archivée avec conservation de son identifiant. Les comptes globalement désactivés, CLIENT et SUPER_ADMIN nécessitent un traitement explicite et ne sont pas rattachés par cette opération.
- Invitation : un e-mail déjà connu peut recevoir l'invitation du premier administrateur d'une nouvelle entreprise. Le titulaire d'un compte actif utilise son mot de passe actuel pour accepter. L'invitation ne remplace jamais les identifiants existants. L'acceptation consomme atomiquement l'invitation et ajoute le rôle local.
- Connexion : rôle et entreprise active sont relus dans les rattachements autorisés côté serveur. Un sélecteur dans la barre supérieure permet le changement d'entreprise. Un identifiant d'entreprise fourni par le navigateur ne donne aucun accès supplémentaire.
- Archivage : seule la fiche locale est désactivée. Suppression : les autres rattachements et le compte de connexion sont conservés ; le lien principal est retiré s'il correspond à la fiche supprimée. Les blocages liés à l'historique véhicule restent actifs.
- Les pages personnelles, absences et plannings sélectionnent la fiche de l'entreprise active. Les changements de chef d'équipe modifient le rôle local.

## Validation effectuée

- `npm run test:employes` : 67 tests réussis, dont 11 nouveaux tests multi-entreprises.
- Génération du client Prisma et validation du schéma réussies.
- Vérification TypeScript de `src/**` et `prisma/seed.ts` réussie. La vérification globale inclut des tests acquisition/booking existants présentant des erreurs de types ; elle ne constitue pas une validation globale réussie.
- Migration SQL exécutée dans un PostgreSQL embarqué PGlite sur des tables représentatives de l'ancien modèle : reprise des rôles, second rattachement autorisé, doublon local refusé, identifiant initial et hash du mot de passe conservés. Cela ne remplace pas une répétition de la migration sur une copie complète de la base.
- ESLint non exécuté : le dépôt ne contient pas de configuration ESLint.
- Aucun essai navigateur avec des comptes réels, aucune migration de production et aucun déploiement effectués.

## Mise en ligne et recette restantes

1. Sauvegarder la base et répéter la migration sur une copie de préproduction.
2. Appliquer `npx prisma migrate deploy`, générer le client et déployer cette version avant d'autoriser des rattachements multiples. Ne pas faire fonctionner l'ancienne version avec de nouveaux rattachements multiples.
3. En préproduction, créer un salarié Noiza puis l'ajouter à Galya avec le même e-mail. Vérifier une seule identité et deux fiches employé.
4. Se connecter avec le mot de passe d'origine, changer d'entreprise, vérifier les pages personnelles et les droits locaux. Tester l'invitation d'un administrateur existant vers une nouvelle entreprise.
5. Archiver puis supprimer la fiche Galya et vérifier que Noiza reste accessible ; tester aussi la suppression de la fiche de l'entreprise principale.
6. Vérifier qu'un salarié ne peut ni sélectionner une entreprise étrangère, ni hériter des droits ADMIN détenus ailleurs.

Après création de rattachements multiples, revenir à l'ancienne contrainte unique demande une décision de reprise des données ; ne pas lancer un retour automatique destructif.
