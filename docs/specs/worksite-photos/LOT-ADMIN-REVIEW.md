# LOT-ADMIN-REVIEW — Contrôle Super Admin des photos d'engins

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement, en revue indépendante (Codex). Non poussé, non déployé, aucune migration distante |
| **Base** | `origin/main` = `ac3ebfc` (Lots 0–3 en production, module actif) |
| **Branche** | `feat/worksite-photos-admin-control` |
| **Origine** | Écart signalé par Nizar le 31/10/2026 : un SUPER_ADMIN ne voyait que le formulaire ouvrier et une liste sans Voir / Valider / Supprimer |
| **Migration** | `20261031090000_worksite_photos_admin_review` (EXPAND, nouvelle ; la migration du Lot 1 n'est pas modifiée) |

## 1. Décisions

| # | Décision | Valeur |
|---|----------|--------|
| D19 | Validation interne | Attribuée (`approvedById`, `approvedByNameSnapshot`) et horodatée **par la base** (`approvedAt := clock_timestamp()`), posée une fois puis figée. Elle **ne change pas le statut** : `PENDING` reste « non envoyée ». `SENT` exige toujours une preuve de transport (D13, D17) ; valider n'envoie rien |
| D20 | Rejet avant envoi | Statut terminal `REJECTED`, distinct de `DELETED`, sans aucun champ de preuve d'envoi. Deux phases : intention (`rejectRequested*`), corbeille Drive, finalisation (`rejectedAt`). L'intention interdit la validation et l'envoi (garde SQL) |
| D21 | Suppression depuis l'interface (remplace **D9** « aucune suppression UI en V1 », sur demande explicite de l'utilisateur) | SUPER_ADMIN uniquement. Photo non envoyée ⇒ D20. Photo **déjà envoyée** ⇒ cycle existant `SENT → DELETED` (`trashRequestedAt` / `trashedAt`), preuve d'envoi immuable, demande attribuée (`trashRequestedById`, `trashRequestedByNameSnapshot`, posés avec la demande puis figés). Une photo envoyée n'est **jamais** requalifiée `REJECTED`. Toujours vers la **corbeille** Drive (`storage.trash`), jamais de suppression définitive |
| D22 | Envoi par l'agent (Lot 4) — **ouvert, à arbitrer** | Proposition : l'agent ne liste que les photos `PENDING`, validées, sans intention de rejet. Aucun envoi n'est activé par ce lot |

## 2. Deux dimensions affichées séparément

| Dimension | Valeurs | Source |
|-----------|---------|--------|
| Validation interne | Validée (par qui, quand) ; À valider ; Non validée (rejetée sans validation) ; **Non tracée (antérieure au contrôle)** | `approvedAt…` |
| Envoi au client | Envoyée (avec preuve de transport) ; Non envoyée (« aucun envoi automatique n'est actif ») | `status` `SENT`/`DELETED` + preuve |
| Suppression | Aucune ; **Suppression à reprendre** ; Supprimée avant envoi ; Supprimée après envoi | intention / finalisation |

## 3. Photos existantes (legacy)

Aucune ligne n'est réécrite par la migration (colonnes nullables, assertions de non-modification). Une photo `PENDING` existante est « à valider ». Une photo `SENT` ou `DELETED` existante garde une validation `NULL`, affichée « non tracée (antérieure au contrôle) » : **aucune approbation historique n'est inventée**, et la garde SQL refuse toute validation après envoi. Les tests le vérifient (sondes SQL §5, test PostgreSQL « photo envoyée »).

## 4. Protocoles

**Autorité** : rôle de session `SUPER_ADMIN` **et** rôle global relu en base (compte actif, entreprise de session active) à l'admission de chaque requête, puis relu sous verrous `FOR SHARE` dans la transaction de validation et dans la transaction d'intention de suppression (phase 1). La finalisation (phase 3) ne relit pas l'autorité : elle conclut une intention déjà autorisée dont la corbeille Drive a eu lieu (§8). Photo hors entreprise ou identifiant invalide ⇒ 404 uniforme, audité `ACCESS_DENIED`. Tout autre rôle ⇒ 403, aucune écriture.

**Validation** : transaction, autorité relue, verrou `FOR UPDATE` sur la photo, décision (`APPROVE` / `REPLAY` / refus 409), écriture conditionnelle, événement `APPROVED` unique.

**Suppression (deux phases idempotentes)** :
1. Transaction : autorité relue, verrou `FOR UPDATE`, intention posée **une seule fois** et attribuée, événement unique `REJECT_REQUESTED` ou `TRASH_REQUESTED`.
2. Hors transaction : `storage.trash` (idempotent ; 404 ⇒ déjà absent, événement `FILE_MISSING`).
3. Transaction : verrou, **relecture de l'état de la photo** (pas de l'autorité), finalisation unique (`REJECTED` ou `DELETED`), événement unique `REJECTED` ou `TRASHED`.

Panne entre 1 et 3 ⇒ « Suppression à reprendre » visible (badge, filtre, bouton Reprendre). Un nouvel appel reprend à la phase 2 sans réécrire l'intention ni dupliquer l'audit. Deux suppressions concurrentes ⇒ une intention, une finalisation. Validation et suppression concurrentes sont sérialisées par le verrou ; une validation postérieure à l'intention est refusée en base.

**Garde SQL** (fonction `worksite_photos_guard_photo`, sur-ensemble strict du Lot 1) : insertion sans validation ni rejet ; `PENDING → REJECTED` seulement après une intention posée par une instruction antérieure ; `REJECTED` terminal ; intention ⇒ envoi refusé ; validation seulement en `PENDING` sans intention ; horodatages posés par la base et figés ; attribution de suppression posée avec la demande puis figée. Toutes les règles et noms de contrainte du Lot 1 sont conservés (test statique et sondes du Lot 1 rejouées).

## 5. Contrats HTTP (session, drapeau, origine pour les mutations, réponses privées)

| Route | Rôle |
|-------|------|
| `GET /api/worksite-photos/review?worksiteId=&filter=&cursor=&limit≤100` | Galerie SUPER_ADMIN ; filtres `ALL`, `TO_REVIEW`, `APPROVED`, `SENT`, `TO_RESUME`, `REMOVED` ; curseur opaque keyset (`uploadedAt DESC, id DESC`), 24 par défaut |
| `POST /api/worksite-photos/:id/approve` | Validation interne ; `Idempotency-Replayed` |
| `POST /api/worksite-photos/:id/trash` | Corbeille deux phases, reprise ; `Idempotency-Replayed`, `resumed` |

Aucune réponse ne contient d'identifiant ni de chemin Drive. Nouveaux codes : `PHOTO_NOT_PENDING`, `PHOTO_REMOVED`, `PHOTO_DELETION_IN_PROGRESS`, `PHOTO_DELETION_CONFLICT` (409).

## 6. Interface

- SUPER_ADMIN : galerie de contrôle **en premier** ; ajout d'une photo dans une section repliable secondaire « Ajouter une photo » (formulaire seul). Les autres rôles gardent leur parcours.
- Vignettes avec commandes empilées pleine largeur (cible 44 px) : Voir, Valider, Supprimer, Reprendre selon l'état ; aperçu privé agrandi par le proxy authentifié ; actions collées en bas du dialogue.
- Après une action, la liste suit le filtre affiché ; aucune action pendant une lecture ni deux fois ; une erreur relit l'état et propose Actualiser ou Reprendre. Une suppression inachevée (Drive ou finalisation en échec) affiche un bouton explicite « Reprendre la suppression » (vignette, détail, filtre dédié) : le journal seul ne suffit pas.
- Bouton « Actualiser » permanent : relit la page courante (photos prises entre-temps), sans interrogation périodique.
- La promesse « transmises au client par Hermes » est retirée ; le statut ouvrier `PENDING` devient « Non envoyée ».

## 7. Tests

| Suite | Contenu |
|-------|---------|
| `photo-review-domain.test.ts` | Transitions, deux dimensions, décisions, filtre, curseur |
| `admin-review-migration-sql.test.ts` | Liste fermée, empreinte figée du Lot 1, sur-ensemble de la garde, ROLLBACK restaurant la fonction du Lot 1 à l'identique |
| `photo-review.service.test.ts` | Matrice de droits, rétrogradation sous verrou, cross-tenant, validation, deux chemins de suppression, panne et reprise, fichier absent, concurrences, pagination de 60 photos |
| `photo-review-api.test.ts` | Drapeau, origine, codes, en-têtes, corps sans Drive, composition incomplète |
| `photos-review-gallery.render.test.tsx` | Commandes, deux dimensions, legacy, synchronisation au filtre, admission des actions, verrou du détail |
| `admin-review.pg.test.ts` + `sql/admin-review-probes.sql` | PostgreSQL jetable : sondes, autorité et isolation, courses réelles, reprises, SENT → DELETED, proxy, plus de 50 photos, ROLLBACK refusé avec données |

## 8. Limites et points ouverts

- **Purge** des photos `REJECTED` (Lot 5) : non implémentée. Google vide la corbeille au plus tard à 30 jours ; le cron de purge devra traiter `REJECTED` (`rejectedAt`) comme `DELETED` (`trashedAt`), avec sa propre trace.
- **Réconciliation** d'une suppression inachevée (Lot 5) : pas de cron dans ce lot ; la reprise se fait par le bouton « Reprendre », idempotente.
- **Finalisation** : l'autorité est relue à la phase 1, pas à la phase 3 ; une finalisation reflète une corbeille déjà effectuée sur Drive.
- **Retour au code précédent** : sans danger tant qu'aucune photo n'est `REJECTED`. Après un rejet, l'ancien client Prisma ne connaît pas cette valeur et sa liste échouerait : le repli exige alors le drapeau OFF. La valeur d'énumération `REJECTED` n'est pas retirée par le ROLLBACK (PostgreSQL ne retire pas une valeur d'enum).
- **Validation indépendante** : interprétée comme indépendante du statut d'envoi. Le principe « quatre yeux » (valideur ≠ auteur) n'est pas imposé : un SUPER_ADMIN peut valider sa propre photo.
- **D22** (sélection de l'agent d'envoi) reste à arbitrer avant le Lot 4.
