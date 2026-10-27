# Revue humaine des suggestions OCR fournisseurs

La catégorie et le compte proposés après OCR sont des aides à la saisie, jamais une approbation comptable. Une réponse sans classification reconnue peut proposer `autre` / `606000` si le document contient des données et si ce compte est actif dans la société. L'interface signale cette proposition comme provisoire. Une extraction vide ne propose aucun compte et affiche un message distinct.

Transport, restauration et carburant ne sont pas des alias d'imputation fiables sans contexte. Ils demandent une revue humaine ; le prompt OCR demande également de ne pas déduire une imputation de ces seuls mots.

## Contrat de validation existant

Le choix retenu dans ce correctif est la revue humaine, et non un nouveau statut serveur de confirmation. Enregistrer une facture la laisse en attente. L'action explicite **Valider et comptabiliser** demande de confirmer la vérification des montants, de la catégorie et du compte, y compris les propositions provisoires. L'opérateur doit les corriger si nécessaire avant d'accepter.

Le serveur contrôle l’accès à la société, l’état de la facture, les comptes, l’exercice et les invariants comptables. Les propositions OCR restent soumises à la revue humaine. Pour la restauration, le contrat de confirmation ci-dessous est en outre appliqué côté serveur.

## Restauration
Le compte actif 625000 de la société est proposé pour la restauration, sans certitude d’imputation selon le contexte. Il reste modifiable ; sans ce compte dans le plan, aucun repli 606 n’est proposé. La validation exige une confirmation du compte enregistré : l’action transmet son identifiant seulement après le dialogue humain, qui affiche le compte. Le serveur compare sous verrou cette confirmation au compte courant avant tout effet de bord. Une confirmation absente ou périmée est refusée. Aucun marqueur persistant ni migration : la confirmation vaut uniquement pour cette action. Les utilisateurs autorisés appelant directement l’action restent responsables d’une confirmation sincère.
