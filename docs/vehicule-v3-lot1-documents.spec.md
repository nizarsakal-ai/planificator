> Note historique du lot Claude Code. Pour le comportement final intégré (5 catégories, 4 Mio et renforcements de sécurité), consulter `planificator-v3-integration.spec.md`.

# Véhicules V3 — Lot 1 : Documents camion

Spécification d'implémentation et notes d'exploitation. Prototype **désactivé par défaut** ; aucune migration exécutée sur staging/production par ce lot.

## Périmètre

Coffre documentaire privé par camion, onglet « Documents » de la fiche véhicule (`/vehicules/[id]`), quatre rubriques : contrôle technique, réparations et entretien, carte grise, assurance. Ajout, remplacement avec versions, validation humaine, archivage, consultation et téléchargement privés, dates et statut documentaire, rappels internes dédupliqués.

Hors périmètre de ce lot : dépenses/carburant, tournées, import PDF/OCR, distances et tableau de bord (lots suivants).

## Activation et variables d'environnement

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PLANIFICATOR_VEHICLES_V3_ENABLED` | Active routes, page et tâche de rappel V3 (valeur exacte `true`) | désactivé → 404 |
| `PLANIFICATOR_TRUSTED_ORIGINS` | Origines supplémentaires acceptées pour les requêtes mutantes (ex. coque Capacitor), séparées par des virgules | aucune |
| `VEHICLE_DOCUMENT_MAX_BYTES` | Taille maximale d'un fichier | 15 Mio |
| `VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX` | Préfixe du dossier Cloudinary | `planificator` |
| `CRON_SECRET` | Déjà utilisé par les crons ; protège `/api/cron/vehicle-document-reminders` | obligatoire pour le cron |

Le SDK Cloudinary lit `CLOUDINARY_URL` comme les autres modules ; aucun secret n'est ajouté par ce lot.

## Modèle de données (migration `20261025120000_vehicles_v3_documents`)

- `vehicle_documents` : dossier logique (entreprise, camion, rubrique, intitulé, version courante, révision, archivage avec auteur et motif).
- `vehicle_document_versions` : version immuable (clé de stockage opaque, `raw`/`authenticated`, nom d'origine, type, taille, empreinte SHA-256, dates civiles `issuedOn`/`validFrom`/`validUntil`, émetteur, référence, observations, kilométrage facultatif, lien facultatif vers une intervention V2, auteur, validation humaine, remplacement, clé d'idempotence et empreinte de commande).
- `vehicle_document_reminder_settings` : seuils de rappel par entreprise (défaut 30 et 7 jours).
- `vehicle_document_reminders` : reçu unique par version, seuil et destinataire (seuil `-1` = expiration).
- `vehicle_audit_logs` : journal en ajout seul (accès fichiers accordés/refusés, ajout, remplacement, validation, archivage, seuils).
- Ajouts sur l'existant : index unique `vehicle_maintenance_entries(id, truckId, companyId)` (cible de FK composite), valeurs `VEHICLE_DOCUMENT_EXPIRING` / `VEHICLE_DOCUMENT_EXPIRED` dans `NotificationType`.

Toutes les FK sont `RESTRICT`, composites avec `companyId`. Triggers : version figée hors validation (une fois) puis remplacement (une fois) ; dossier jamais supprimé, identité et rubrique figées, révision croissante, désarchivage interdit ; reçus et audit en ajout seul. Les valeurs d'énumération sont ajoutées hors transaction (contrainte PostgreSQL), le reste est atomique avec gardes de prérequis et assertions finales.

Procédure (soumise à autorisation distincte) : sauvegarde, `prisma migrate deploy` sur une base de recette d'abord, vérification des assertions, puis production ; retour applicatif = désactivation du drapeau (les tables additives restent inertes).

## Droits effectifs

L'autorité V2 (`vehicle-authority`) relit sous verrou l'identité, l'entreprise active et l'appartenance effective ; V3 n'ajoute qu'une matrice explicite :

| Action | ADMIN / SUPER_ADMIN (entreprise explicite) | Chef d'équipe affecté au camion | Employé, chauffeur, client |
| --- | --- | --- | --- |
| Lister, consulter, télécharger | toutes rubriques | CT, entretien, assurance (carte grise masquée et refusée) | refusé |
| Ajouter, remplacer, valider, archiver | oui | refusé | refusé |
| Seuils de rappel | oui | refusé | refusé |

Aucun droit implicite au chauffeur : son affectation V1 ne lui ouvre rien. Une interface masquée ne remplace jamais un refus serveur.

## API (toutes privées, `Cache-Control: private, no-store`, NetworkOnly côté PWA)

| Méthode et route | Rôle |
| --- | --- |
| `GET /api/trucks/:id/documents` | Liste par rubrique avec statut calculé |
| `POST /api/trucks/:id/documents` | Ajout (multipart `file` + `payload` JSON, en-tête `Idempotency-Key` UUID) |
| `GET /api/trucks/:id/documents/:documentId` | Détail et toutes les versions |
| `POST …/:documentId/versions` | Remplacement (multipart, `expectedRevision`) |
| `POST …/:documentId/verify` | Validation humaine (`expectedRevision`, `versionId`) |
| `POST …/:documentId/archive` | Archivage (`expectedRevision`, `reason`) |
| `GET …/:documentId/versions/:versionId/file[?dl=1]` | Proxy privé du fichier (audit avant accès) |
| `GET/PUT /api/vehicle-documents/reminder-settings` | Seuils de rappel de l'entreprise |
| `GET /api/cron/vehicle-document-reminders` | Tâche de rappel (Bearer `CRON_SECRET`), non déclarée dans `vercel.json` |

Les requêtes mutantes exigent `Sec-Fetch-Site: same-origin`, ou un en-tête `Origin`/`Referer` égal à l'hôte servi ou présent dans `PLANIFICATOR_TRUSTED_ORIGINS`.

## Règles métier

- Statut documentaire calculé à la lecture dans le fuseau `CompanySettings.timezone` : manquant, à vérifier, valable, bientôt échu (dans le plus grand seuil), expiré, historique (version remplacée), archivé. Une pièce présente n'est pas validée tant qu'un humain ne l'a pas marquée vérifiée.
- Carte grise : pas d'échéance (refusée). Contrôle technique : aucune périodicité présumée, l'échéance est saisie.
- Réparations/entretien : kilométrage facultatif (information seulement, le compteur V2 n'est jamais modifié), lien facultatif vers une intervention V2 du même camion ; une facture ancienne sans kilométrage est conservée telle quelle.
- Fichiers : PDF, JPEG, PNG ; nom nettoyé, type déclaré, extension et signature doivent concorder ; PDF avec JavaScript, action d'ouverture ou fichier embarqué refusé ; taille bornée avant lecture.
- Publication : contrôle sous verrou (aucun octet envoyé si refus) → téléversement privé (clé `prefix/entreprise/vehicles/camion/documents/dossier/version-empreinte.ext`, `overwrite: false`) → transaction de rattachement (droit et idempotence relus). Échec après téléversement : compensation du seul objet créé par l'appel ; échec de compensation journalisé pour réconciliation, jamais de suppression hasardeuse.
- Remplacement : nouvelle version, l'ancienne reçoit `supersededAt` et reste consultable ; alertes de rappel de l'ancienne version marquées lues. Deux remplacements concurrents : le second reçoit `DOCUMENT_REVISION_CONFLICT`.
- Camion archivé : pièces consultables, validation et archivage possibles, ajout et remplacement refusés (`TRUCK_ARCHIVED`), comme les écritures V2.
- Rappels : pour chaque version courante datée d'un dossier non archivé, un rappel par seuil atteint et un rappel d'expiration, à chaque administrateur actif de l'entreprise ; reçu unique → rejeu sans doublon. Les e-mails/SMS restent une décision séparée.

## Limites connues

- Le téléchargement passe par un proxy serveur : révocation immédiate garantie, coût de bande passante côté application.
- Les destinataires des rappels sont les administrateurs actifs ; pas de configuration par destinataire.
- Les liens d'intervention sont saisis par identifiant dans ce lot (champ texte) ; un sélecteur viendra avec le lot Dépenses.
- La page fiche véhicule suit les droits de la page Véhicules (ADMIN / SUPER_ADMIN) ; l'API conserve la matrice chef d'équipe pour les usages mobiles futurs.
