# LOT-PHOTO-RECIPIENTS — Destinataires des photos par chantier

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement, en revue indépendante (Codex). Non poussé, non déployé, aucune migration distante |
| **Base** | `origin/main` = `dbf1cf1` (LOT-ADMIN-REVIEW en production) |
| **Branche** | `feat/worksite-client-contact` |
| **Origine** | Demande de Nizar du 31/10/2026 : plusieurs destinataires par chantier (exemple : une conductrice de travaux en congé, envoyer aussi à son responsable et au directeur d'exploitation) |
| **Migration** | `20261031150000_worksite_photo_recipients` (EXPAND) |
| **Envoi** | **Aucun**. Ce lot ne fait que configurer des destinataires |

## 1. Modèle retenu : table dédiée

`worksite_photo_recipients` plutôt qu'une colonne JSON typée : la base garantit l'unicité de l'adresse par chantier, la forme de chaque ligne (CHECK), l'isolation d'entreprise (FK composite) et la borne de 20 ; les identifiants restent stables pour un futur journal d'envoi.

| Colonne | Contrat |
|---------|---------|
| `id` | clé |
| `companyId`, `worksiteId` | FK composite `(worksiteId, companyId) → worksites(id, companyId)`, `ON DELETE CASCADE` (configuration supprimée avec le chantier, qui peut être supprimé définitivement) |
| `label` | nom / fonction, facultatif, 1 à 120 caractères trimés |
| `email` | une seule adresse, trimée, 3 à 254 caractères, sans espace ni `, ; < >` |
| `emailKey` | `lower(email)` imposé par CHECK ; **unique avec `worksiteId`** (insensible à la casse) |
| `active` | désactivation temporaire sans effacement |
| `position` | 0 à 19 (ordre d'affichage) ; **aucune contrainte d'unicité** : ni réorganisation ni remplacement complet ne peut provoquer de conflit transitoire |
| `createdById`, `updatedById` | attribution (scalaires) |
| `createdAt`, `updatedAt` | posés par la base |

Déclencheur `worksite_photo_recipients_guard` : **verrouille le chantier (même tenant) puis compte** — 20 destinataires au plus, même pour deux insertions directes concurrentes hors du service ; identité et création figées ; `updatedAt` posé par la base.

**Marqueur** `worksites.photoRecipientsConfiguredAt` (nullable) : `NULL` = jamais configurée. Posé **une seule fois**, par la base, dans la transaction du **premier enregistrement, y compris une liste vide**. Il distingue « jamais configurée » de « vidée volontairement ».

## 2. Contrat du formulaire (`updateChantier`)

Un seul champ `photoRecipients` contenant une liste JSON `[{ label, email, active }]` :

| Champ reçu | Effet |
|------------|-------|
| absent | configuration conservée (écriture historique de `updateChantier`, inchangée) |
| `[]` | effacement explicite de la liste ; marqueur posé s'il ne l'était pas |
| liste valide | appliquée par différence sur l'adresse (retraits, mises à jour, ajouts ; un destinataire conservé garde son identifiant) |
| répété, fichier, JSON invalide ou > 16 Kio, > 20 lignes, clé inconnue, `active` non booléen, e-mail invalide ou multiple, nom > 120, doublon (casse ignorée) | **refus**, aucune lecture ni écriture ; message citant la ligne, jamais l'adresse |

L'éditeur n'envoie la liste **que si elle a été modifiée** : enregistrer le nom du chantier ne configure jamais la liste à l'insu de l'utilisateur.

## 3. Autorité et atomicité

- **Écriture** : rôle de session `SUPER_ADMIN`, sinon refus avant toute lecture (ADMIN, TEAM_LEADER ; EMPLOYEE garde le refus existant). Dans **une** transaction, sans réseau (le géocodage est fait avant) : compte puis entreprise relus sous `FOR SHARE` (compte actif, rôle global `SUPER_ADMIN`, entreprise de session active), chantier verrouillé `FOR UPDATE` dans l'entreprise de session, champs du chantier, liste, marqueur, audit. Tout ou rien.
- **Lecture** : la page détail relit en base compte actif, rôle global `SUPER_ADMIN` et entreprise active **avant** toute lecture des adresses ; une session périmée ne lit rien. Aucune adresse n'est sérialisée vers les autres rôles (ni props, ni HTML).
- **Audit** : événement `RECIPIENTS_SET` (journal des photos) seulement si la liste change ou au premier enregistrement ; détail limité à des compteurs (`total`, `active`, `added`, `removed`, `updated`, `firstConfiguration`) ; nom d'acteur sans e-mail.
- Les droits historiques des autres champs du chantier ne changent pas.

## 4. Compatibilité de `Worksite.clientContact`

`clientContact` (contrat agent v1, **une** adresse) n'est **ni surchargé, ni modifié, ni effacé**. Tant que la liste n'a **jamais** été configurée, sa valeur est seulement **suggérée** dans l'éditeur (« Adresse historique (non utilisée) », bouton explicite « Ajouter comme destinataire ») ; elle n'est jamais préremplie ni enregistrée d'office. Une fois la liste configurée — même vide, même entièrement inactive — elle n'est plus jamais suggérée ni considérée comme destinataire. Le scénario vider → recharger → réenregistrer est testé.

## 5. Interface

- Formulaire de modification, sous **Client** : « Destinataires des photos », aide « Destinataires propres à ce chantier. Aucun envoi automatique. », lignes nom / fonction (facultatif), e-mail (`exemple@client.fr`), case **Actif**, **Retirer**, **Ajouter un destinataire** (désactivé à 20). Éditeur désactivé pendant la sauvegarde ; échec réseau ou serveur ⇒ message, saisie conservée.
- Carte **Informations** (hors édition) : liste lisible, destinataires inactifs barrés, « Non configurés » ou « Aucun destinataire (liste vidée) » ; SUPER_ADMIN confirmé en base uniquement.
- Aucune reprise de l'adresse comptable du client (`Client.email`).

## 6. Consignes pour le futur Lot 4 (envoi par l'agent) — non implémenté ici

- Lire la **collection des destinataires actifs** du chantier (`active = true`), pas `clientContact`, et pas seulement le premier e-mail.
- Un chantier configuré sans destinataire actif ⇒ **aucun envoi** (jamais de repli sur `clientContact`).
- Adapter la **preuve d'envoi** au multi-destinataires : l'ancienne preuve (`sentTo` unique) ne prouve pas que tous les destinataires ont reçu ; une décision (une preuve par destinataire ou une preuve d'acceptation listant tous les destinataires) doit être arbitrée avant le Lot 4, avec D22 (LOT-ADMIN-REVIEW).

## 7. Tests

| Suite | Contenu |
|-------|---------|
| `photo-recipients-field.test.ts` | absent ≠ vide, normalisation, refus (répété, fichier, JSON, borne, doublon de casse, e-mail, nom, clés), compatibilité historique |
| `update-chantier-recipients.action.test.ts` | doubles de modules : refus par rôle et par forme sans lecture ni écriture, chemin historique inchangé (dates nullables, contact non touché), cœur seul pour le SUPER_ADMIN, géocodage hors transaction |
| `photo-recipients-editor.render.test.tsx` | intitulés, aide, champs sans nom, suggestion explicite, borne, désactivation ; lecture relue en base (session périmée) |
| `photo-recipients.pg.test.ts` | PostgreSQL jetable : rollback à vide puis ré-application, marqueur (liste vide), plusieurs destinataires, désactivation, identifiants stables, réorganisation et remplacement complet, vider → recharger → réenregistrer, autorité relue, isolation, atomicité après écritures, contraintes, borne sous concurrence hors service, rollback refusé |

## 8. Limites

- La garde de périmètre `tests/chantiers/parity/scope-guard.test.ts` (propre au lot 1W-1a, comparée à un commit figé) échoue déjà sur `main` : elle n'est pas modifiée ici.
- Le marqueur est posé une fois et n'est jamais remis à `NULL` par l'application ; aucune contrainte SQL ne l'empêche (pas de déclencheur ajouté sur `worksites`).
- Repli : retour au code précédent sans risque (table et colonne ignorées). Le ROLLBACK SQL n'est pas destructif : il refuse dès qu'un destinataire existe ou qu'un chantier est marqué configuré.
