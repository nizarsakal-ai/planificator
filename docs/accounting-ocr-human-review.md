# Revue humaine des suggestions OCR fournisseurs

La catégorie et le compte proposés après OCR sont des aides à la saisie, jamais une approbation comptable. Une réponse sans classification reconnue peut proposer `autre` / `606000` si le document contient des données et si ce compte est actif dans la société. L'interface signale cette proposition comme provisoire. Une extraction vide ne propose aucun compte et affiche un message distinct.

Transport, restauration et carburant ne sont pas des alias d'imputation fiables sans contexte. Ils demandent une revue humaine ; le prompt OCR demande également de ne pas déduire une imputation de ces seuls mots.

## Contrat de validation existant

Le choix retenu dans ce correctif est la revue humaine, et non un nouveau statut serveur de confirmation. Enregistrer une facture la laisse en attente. L'action explicite **Valider et comptabiliser** demande de confirmer la vérification des montants, de la catégorie et du compte, y compris les propositions provisoires. L'opérateur doit les corriger si nécessaire avant d'accepter.

Le serveur contrôle l'accès à la société, l'état de la facture, les comptes, l'exercice et les invariants comptables. Il ne possède pas de marqueur persistant « classification OCR confirmée ». Un appel direct à l'action par un utilisateur autorisé peut donc valider une proposition sans passer par le dialogue client : celui-ci n'est pas une protection serveur. Les appelants autorisés restent responsables de cette revue humaine. Aucun test ne doit revendiquer le rejet serveur d'une classification non confirmée.

Un verrou serveur distinct nécessiterait un contrat de confirmation et sa traçabilité persistante, avec invalidation après modification de catégorie/compte ; il ne fait pas partie de ce changement. Aucune nouvelle migration ni activation de comptabilisation automatique n'est incluse.
