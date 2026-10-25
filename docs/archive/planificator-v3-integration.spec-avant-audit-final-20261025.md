# Planificator V3 — Livraison intégrée de développement

Base Git : `c5a6c481620204e62a414c92aea46903259f4c02`. Aucune migration ni donnée de production modifiée. Fonctionnalités désactivées par défaut ; activation explicite `PLANIFICATOR_VEHICLES_V3_ENABLED=true`.

## Parcours livrés

- Fiche camion : navigation Documents, Tournées, Coûts et Imports selon les droits effectifs.
- Documents : contrôle technique, réparations/entretien, carte grise, assurance et justificatifs de dépenses. Historique de versions, vérification humaine, archivage, dates de validité et rappels internes dédupliqués. Les documents futurs restent « À venir ».
- Stockage privé existant Cloudinary authenticated/raw. Aucun lien public livré au navigateur. Autorisation entreprise/camion avant et après récupération ; taille et empreinte vérifiées. PDF/JPEG/PNG, 4 Mio maximum, métadonnées et flux bornés. Les contrôles de signature et de contenu PDF ne remplacent pas un antivirus.
- Dépenses : carburant, autres frais, références aux justificatifs et interventions ; montants décimaux, correction historisée, idempotence et protections SQL. Les références restent liées au même camion et à la même entreprise. Les achats de carburant ne sont pas présentés comme une consommation réelle.
- Coûts : total par période et imputation explicite par trajet, sans ajouter les imputations une seconde fois au total véhicule. Kilomètres réels du journal V2 ; couverture partielle signalée. Observations kilométriques des achats séparées du compteur validé.
- Tournées : étapes ordonnées, adresses confirmées, réservation chauffeur/équipe/camion, démarrage et clôture atomiques avec le journal V2. Horaires civils du fuseau entreprise, contrôle des changements d’heure. Fin à minuit traitée comme borne exclusive.
- Imports : texte/PDF/photo, preuve source privée, correction et confirmation humaine avant approbation puis consommation atomique par une tournée. Révision, isolation entreprise, quotas et transitions SQL protégés. Une extraction ne crée pas automatiquement un chantier ou une tournée.

## Services et exploitation

Cloudinary exige la configuration existante `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Aucun secret n’est inclus dans cette livraison. Les fichiers privés et leur historique consomment du stockage ; coût réel dépend du contrat et du volume, non mesuré ici.

OCR externe désactivé par défaut. Il exige le consentement sur le fichier, `PLANIFICATOR_VEHICLE_OCR_ENABLED=true`, `PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK=true` et la configuration Anthropic existante. Routage explicite : `PLANIFICATOR_ROUTING_ENABLED=true` et `PLANIFICATOR_ROUTING_OSRM_URL`. Géocodage explicite : `PLANIFICATOR_VEHICLE_GEOCODING_ENABLED=true` et consentement. Ces fournisseurs peuvent entraîner des frais et doivent être validés avant activation.

La tâche quotidienne `/api/cron/vehicle-document-reminders` est déclarée à 06:00 UTC et exige `CRON_SECRET` ainsi que le drapeau V3. Elle crée des rappels internes ; aucun email/SMS n’est envoyé par cette livraison. Les pages et API véhicules privées sont exclues du cache PWA.

La limite de 4 Mio ménage une marge pour l’enveloppe multipart sous la limite Vercel de 4,5 MB : https://vercel.com/docs/functions/limitations . Les fichiers plus volumineux demanderaient un parcours d’envoi direct privé dédié.

## Validation et limites

506 tests véhicules automatisés réussis (219 V1, 177 V2, 110 V3) et contrôle TypeScript véhicules sans erreur. Compilation de production Next.js réussie, vérification des types et génération des 61 pages comprises. Les 60 migrations s’appliquent à une base PostgreSQL 16 vide. Sept suites PostgreSQL finales : 14 tests réussis, aucun ignoré, dont parcours transversal document → dépense → import validé → tournée → journal V2 → coût corrigé.

Recette navigateur locale réussie : connexion administrateur, quatre onglets, création de tournée et dépense persistées ; chef affecté en lecture des trois rubriques opérationnelles sans accès aux rubriques administratives.

Les essais utilisent uniquement des données fictives et, pour le stockage, un fournisseur mémoire injecté dans les tests. Les échanges réels Cloudinary/OCR/routage/géocodage ne sont pas validés avec des identifiants de production. Ils restent un point de recette avant activation.

La note `vehicule-v3-lot1-documents.spec.md` conserve la trace historique du premier lot Claude Code et ne décrit pas l’état final intégré.

Préparation fournisseurs réels : initialisation Cloudinary autonome corrigée (triplet ou CLOUDINARY_URL), scripts reproductibles et runbook `vehicle-v3-release.md` ajoutés. Les essais authentifiés Cloudinary/OCR sont reportés à la demande de Nizar ; ils restent un prérequis avant activation.
