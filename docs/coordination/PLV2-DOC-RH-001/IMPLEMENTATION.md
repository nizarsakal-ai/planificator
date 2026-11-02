# PLV2-DOC-RH-001 — réalisation locale
Base : main 28c1f884a7732c27307d5d9684c102af9e8da23f. Autorisation Nizar du 2 novembre 2026 : Codex remplace Claude pour développement et tests isolés, sans partages existants, données RH réelles ni déploiement. RULE-001. État : IN_REVIEW jusquà remise des preuves finales ; pas RELEASED/CLOSED.

## Architecture réalisée
Routes /mes-documents et /rh/documents, service comme autorité unique, dépôt PDF privé et revue humaine versionnée avant publication. Import unitaire ou sélection multiple (10 fichiers au maximum) avec affectation explicite par fichier ; aucun découpage dun PDF collectif, aucune IA ou extraction externe obligatoire. Les listes serveur sont bornées par pages de 25 ; filtres de catégorie/année limités aux pages chargées et explicitement étiquetés. Annuaire borné à 500 actifs, limite à requalifier avant plus grands volumes.

Métadonnées additives HrDocument* et FK composites, version optimiste, événements/receipts transactionnels et notices distinctes. Stockage privé spécifique, root ID séparé de Photos ; adapter de transport Google en lecture/création uniquement, sans partage/corbeille/suppression. Réutilisation de la connexion transport Photos du même compte explicitement lié (pas copie de credentials), scope drive.file inchangé. Le refresh ordinaire peut mettre à jour le token partagé selon le client existant ; la déconnexion/reconnexion Photos entraîne un refus RH et exige une réassociation explicite au même compte/racine. Aucun changement de rootFolderId Photos ni de Gmail. Cette dépendance de transport est assumée pour éviter un nouveau consentement/provider.

Compte cible de production choisi : galyaevents1@gmail.com. Aucun compte ni identifiant production dans le code ou les exemples. La configuration doit mapper explicitement société/compte et opérateurs ; aucun droit par seul rôle ADMIN/SUPER_ADMIN. Aucun accès aux bulletins pour responsables déquipe par défaut.

## Garanties et reprises
Les octets complets approuvés sont vérifiés avant émission (10 Mo max) ; ACL privées owner-only et parent contrôlés avant/après lecture. Aucun lien brut Drive ou token renvoyé au salarié. Mutation distante bloque la remise ; reverify et restauration de loriginal exigent de nouvelles revue/publication, sans changement de bénéficiaire si déjà publié. Les références des anciennes copies restent dans les événements, sans effacement.

Reprise UPLOADING après rechargement : auteur habilité soumet exactement le PDF réservé par ID et version ; clé navigateur non nécessaire. Root initiale réservée puis création idempotente reprise. Upload et appels Google hors transaction ; finalisation réautorise et verrouille connexion réelle ACTIVE/compte/génération. Révocations user/company/employee synchronisées avec les verrous FOR SHARE ; opérateurs configurés côté serveur relus par commande. Aucun éditeur dhabilitations ni droits réels attribués.

Formulaire remonté par id+version, confirmation remise à zéro ; documents REVIEWED sont en lecture de revue jusquà commande explicite dinvalidation. Les collaborateurs avec documents sont conservés : garde additive de suppression si module actif et FK RESTRICT, archivage recommandé. Flag absent conserve le chemin historique sans nouvelle requête HR.

Email : notice durable à la publication ; envoi seulement si flag séparé actif, après commit, via transport Resend existant. Un seul envoi par notice/version, clé didempotence et aucun PDF ni salaire. Erreur ambiguë ou envoi resté PROCESSING : pas de renvoi aveugle ; rapprochement opérateur requis, pas de commande de renvoi forcé implémentée. Aucun cron nouveau. La publication reste réussie même si mail non confirmé. Sans clé/flag, aucun envoi réel.

## Limites assumées et portes avant activation
Usage initial COPIES DOCUMENTAIRES ; aucun coffre-fort certifié revendiqué et aucune bascule de remise officielle uniquement électronique. Conservation 50 ans, continuité, backup indépendant, restauration et identité personnelle après départ non qualifiés par ce lot. Un salarié inactif est refusé : le parcours durable après départ reste à réaliser et valider avant usage officiel. Drive seul nest pas une preuve de conformité. Lopposition et les circuits officiels restent à vérifier. Lantivirus/sandbox documentaire au-delà de signature PDF et téléchargement attachment/CSP ne sont pas réalisés ; seuls opérateurs explicitement habilités déposent, aucune ouverture inline automatique.

Les modifications de schéma sont préparées mais aucune migration de déploiement appliquée. Schéma matérialisé seulement dans un nouveau PostgreSQL Docker jetable pour tests. Flags et comptes production inchangés ; pas de commit/push/merge/build distant. Une PRR et un mandat de schéma/activation séparés restent nécessaires.

## Configuration prévue, désactivée par défaut
HR_DOCUMENTS_ENABLED=false
HR_DOCUMENT_MAIL_ENABLED=false
HR_DOCUMENT_OPERATORS=[]
HR_DOCUMENT_DRIVE_ACCOUNTS={}

Format opérateurs synthétique : [{"userId":"test-operator","companyId":"test-company","capabilities":["READ","IMPORT","PUBLISH","CONFIGURE"]}]. Droits minimaux à attribuer hors recette via procédure autorisée. Mapping compte synthétique : {"test-company":"storage@example.test"}. La racine est créée uniquement par action CONFIGURE explicite après mise en service autorisée, owner-only, sans reprendre les documents historiques.

## Vérification reproductible
Node 22, npm ci verrouillé. npm run test:hr-documents ; npm run typecheck:hr-documents. Tests PG : HR_DOCUMENT_TEST_DATABASE_URL doit pointer localhost/127.0.0.1, base exactement planificator_hr_docs_test, exclusivement synthétique ; npm run test:hr-documents:pg. Le test refuse toute autre destination et ne charge aucun .env réel. Appliquer le schéma dans cette base vide seulement avant tests, jamais réutiliser une DATABASE_URL production. Pas de tests matériels/téléphone physique ou appels Google réels revendiqués.

Retour arrière : ne pas activer les flags ; si ultérieurement activés, désactiver le module sans effacer tables ni fichiers. Les données conservées empêchent une suppression physique de salarié ; le rollback ne doit pas réouvrir une voie destructive. Ne pas supprimer les traces ou la racine RH sous prétexte de retour de code.
