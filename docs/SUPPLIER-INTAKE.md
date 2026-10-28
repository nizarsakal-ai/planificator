# Factures fournisseurs & OCR — accès complémentaire

L'espace `/factures-fournisseurs` conserve le rôle et les accès existants. Il est réservé aux comptes EMPLOYEE/TEAM_LEADER explicitement habilités, actifs et rattachés à la société active de leur session. Les pages, actions et fichiers appliquent les contrôles côté serveur. Seuls les propres dépôts sont accessibles. Les pièces validées/rejetées restent en consultation seule. Validation comptable et paiement restent réservés aux habilitations comptables existantes.

Configuration serveur (aucune donnée nominative dans Git) :
- `SUPPLIER_INTAKE_GRANTS` : liste JSON de couples exacts `userId`/`companyId` ; ou
- `SUPPLIER_INTAKE_EMPLOYEE_IDS` : liste JSON d'identifiants de fiches employés vérifiées. Le serveur contrôle que la fiche appartient au compte et à la société de session, avec compte, fiche et société actifs. Un nom ou e-mail ne constitue jamais une habilitation.

Valeurs absentes/invalides : accès refusé. Le module comptable doit être actif. L'OCR garde son drapeau/prestataire existant ; sans OCR, import et saisie manuelle restent possibles. Une preuve signée temporaire d'import utilise le secret d'authentification existant (32 caractères minimum), sans nouvelle clé. Les pièces sont exclues du cache hors ligne.

Aucune migration. Pour retirer l'accès, retirer l'identifiant de la configuration serveur puis republier selon le fonctionnement des variables Vercel. Ne pas supprimer les dépôts existants. Vérifier en recette : menu mobile/bureau, import, corrections, état PENDING, refus d'une pièce d'autrui ou d'une autre société, refus de validation/paiement et refus d'édition après validation.

Tests : `node --import tsx --experimental-test-module-mocks --test tests/accounting/supplier-intake.test.ts tests/accounting/supplier-intake.actions.test.ts`. Contrôles comptables et navigation existants à conserver. La configuration nominative reste hors des sources et livrables de coordination.
