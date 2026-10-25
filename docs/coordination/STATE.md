# État vérifié — correction des modifications véhicule, 25 octobre 2026

Demande active terminée : empêcher la validation prématurée et rendre toutes les rubriques véhicule modifiables avec validation volontaire. Documents (dont contrôle technique), identité, entretien, kilométrage, coûts, imports et tournées disposent des parcours de modification adaptés à leur historique. Entrée dans un champ ne soumet plus ces formulaires. Les versions précédentes sont conservées.

Production : https://www.galyaevents.fr, déploiement dpl_4hyzjRwMBSuyrGQNGmpbhxuxC69F READY, code 3609f872d437cc0e3dcad29338d0198ff15af7e9. Préproduction finale dpl_Ad2YmrFFJVwNMS7nXQXxMjnpwyPx READY ; 583 fichiers applicatifs identiques au candidat production. Repli applicatif disponible : dpl_KAi3xB8NvVboLu5oU3B6HwYbrrHW. Migration additive compatible avec l’ancienne application ; ne pas retirer les données d’historique pour revenir au code précédent.

Neon : branche d’origine br-restless-king-al1y1sqf et endpoint d’origine conservés, 63 migrations actives avec empreintes conformes, zéro structure invalide. Aucune restauration, aucun échange de branche. Sauvegardes existantes préservées et rétention PITR21600s vérifiée ; quota d’instantanés atteint, aucune nouvelle sauvegarde revendiquée.

Vérification : 550 tests véhicules (219+178+144+9), typage ciblé PASS, 21 tests PostgreSQL local PASS, recontrôle Neon ciblé : 4 scénarios métier PASS (9 entrées TAP, dont 5 fichiers sans scénario correspondant au filtre), rejeu des63 migrations PASS. Les erreurs globales de typage se trouvent dans les tests acquisition/booking non modifiés ; ne pas déclarer le typage global réussi. Essais navigateur : version documentaire vérifiée→nouvelle version à vérifier, Enter sans soumission, préremplissage, annulation, import approuvé modifié par copie, tournée terminée corrigée sans modifier les23km réalisés. En production, formulaire Modifier ouvert sur le contrôle technique réel et refermé sans écriture métier ; nouvelles routes privées/origines vérifiées.

Coordination : gateway.py context consulté10:59:37UTC, VPS Hostinger srv2065452. Contrôleur limité au dépôt test ; aucune nouvelle mission Claude exécutée, aucune utilisation d’un lanceur pour contourner la validation. Trois agents Codex ont travaillé sur des périmètres distincts et relu les corrections. Les revues Claude historiques portent sur le code antérieur et ne valent pas approbation de cette correction. Raspberry distinct, aucune réparation revendiquée.

Dossier détaillé : docs/coordination/VEHICLE_EDIT_RELEASE.md. Preuves : outputs/vehicle-edit-final dans l’espace de reprise. Dépôt initial utilisateur laissé intact ; modifications et commits dans la branche de travail isolée. Pas de push ni de fusion distante revendiqués.

Prochaine action : rafraîchir la fiche véhicule, ouvrir Modifier, compléter les champs puis Valider les modifications. Aucun travail de correction connu restant dans le périmètre de cette demande.
