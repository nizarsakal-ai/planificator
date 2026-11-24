# Ticket local — défauts historiques des workers contenu / pièces jointes (flag LOT-4B coupé)

| Champ | Valeur |
|---|---|
| Statut | **Corrigé sur branche locale** `claude/fix-artefacts-defauts-historiques` (non poussée, non fusionnée) |
| Origine | Revue LOT-4B (24/11/2026), décision Codex : ticket séparé, LOT-4B reste désactivé |
| Périmètre | `attachment-download.service.ts`, `message-content.service.ts`, `resolve-acquisition-mailbox.ts` (chemin historique) |
| Tests défensifs | `tests/integration/persistence/artifact-historical-defects.pg.test.ts` — `npm run test:integration:artifact-defects:pg` (PostgreSQL jetable) |
| Dépendances | Aucune pour D2 ; D1 peut réutiliser le code `ARTIFACT_RESOLUTION_FAILED` de LOT-4B s'il est fusionné avant |

Les tests figent le comportement **actuel** de `main`. Un correctif doit modifier exactement les assertions marquées « comportement actuel à corriger », sans toucher aux autres.

## D1 — Panne de lecture pendant la résolution de boîte

**Constat.**
- Le cas concerne un message historique (`sourceMailboxKey` vide) : `resolveAcquisitionMailboxForMessage` lit les boîtes actives en base.
- Si cette lecture échoue, l'exception remonte au worker. Le contenu tombe dans le `catch` de l'orchestrateur.
- Pour une pièce, l'échec arrive **après** la réservation (`claimForDownload`) : la pièce reste `PENDING_DOWNLOAD`, sans code d'erreur, jusqu'au passage de récupération (TTL de réservation : 20 min par défaut).
- Pendant ce temps, un autre worker et la ré-extraction manuelle voient `ALREADY_IN_PROGRESS`.

**Preuves** (tests défensifs D1, 3/3) :
- exception remontée, 0 appel fournisseur, pièce `PENDING_DOWNLOAD` avec `lastErrorCode` nul et compteur de reprise à 0 ;
- second appel : `ALREADY_IN_PROGRESS` ;
- `reclaimPendingDownload` libère la pièce, puis le téléchargement réussit : **aucune perte** ;
- contenu : exception, rien n'est écrit, la lecture suivante réussit ;
- clé explicite : aucune lecture de boîte, donc ce défaut ne la concerne pas.

**Gravité** : faible. Il y a un délai (≤ TTL), pas de perte. Seuls les messages à clé vide sont concernés : ce sont les anciens messages, puisque chaque scan multi-boîte pose la clé.

**Correctif proposé** : capturer l'exception de la résolution historique. Pour la pièce : `markFail("FAILED", <code repris>)` ; pour le contenu : un code `RETRYABLE`.

**Compatibilité**

| Aspect | Aujourd'hui | Après correctif | Risque |
|---|---|---|---|
| Statut de la pièce | `PENDING_DOWNLOAD` jusqu'à la récupération | `FAILED` + `downloadNextRetryAt` | Changement voulu |
| Compteur de reprise | Non incrémenté (la récupération remet en `DISCOVERED`) | Incrémenté à chaque panne | Une longue panne base peut épuiser `maxRetries` plus vite. À couvrir par un code dédié, ou par un compteur non incrémenté pour une panne d'infrastructure |
| Statistiques des orchestrateurs | Exception comptée comme erreur inattendue | Échec typé | Tableaux de bord : nouvelle catégorie |
| Code utilisé | — | `ARTIFACT_RESOLUTION_FAILED` (si LOT-4B fusionné), sinon `GMAIL_UNAVAILABLE` (contenu) / nouveau code repris (pièce) | Les tests qui figent la liste des codes de reprise (`attachment-retry.policy`, `manual-reextract-preparation`) sont à mettre à jour |
| Exceptions des appelants | Les routes et la ré-extraction manuelle attrapent déjà les exceptions | Aucune exception | Aucun |

## D2 — Clé de boîte explicite d'une autre société

**Constat.** Pour une clé explicite, `resolveAcquisitionMailboxForMessage` renvoie la clé telle quelle, sans vérifier la société, et les workers la transmettent au fournisseur.

**Garde-fou existant.** L'adaptateur Gmail réel cherche le jeton avec `id + companyId + active` (`PrismaAcquisitionGmailConnectionClient.findConnection`). Le jeton de l'autre société n'est donc jamais lu ni rafraîchi, et **Google n'est jamais appelé**.

**Preuves** (tests défensifs D2, 3/3) :
- message de A pointant vers la boîte de B, pièce : `GMAIL_NOT_CONNECTED`, 0 appel à l'API Gmail, ligne de la boîte de B inchangée (jeton et `updatedAt`) ;
- contenu : `GMAIL_NOT_CONNECTED` (`CONFIG_TENANT`), 0 appel ;
- témoin : la bonne boîte est bien lue par le même adaptateur.

**Comportement actuel à corriger.** `GMAIL_NOT_CONNECTED` est repris pour les pièces : une telle pièce est retentée jusqu'au plafond, sans aucune chance de réussir. Par ailleurs, la protection dépend de chaque adaptateur, et non du worker.

**Gravité** : faible. Il n'y a ni fuite ni appel distant. Un tel message ne peut naître que d'une écriture incohérente : l'admission et le scan posent une boîte de la société.

**Correctif proposé.** Dans le chemin historique, vérifier l'appartenance de la clé explicite (`findFirst {id, companyId}`) avant la lecture. Sinon, échouer avec un code **non repris** (par exemple `TENANT_MISMATCH`, déjà présent dans les codes de pièces).

**Compatibilité**

| Aspect | Aujourd'hui | Après correctif | Risque |
|---|---|---|---|
| Code d'échec | `GMAIL_NOT_CONNECTED` (repris) | `TENANT_MISMATCH` (non repris) pour la pièce ; à définir pour le contenu | Changement voulu ; les messages visibles pour l'utilisateur sont à revoir |
| Requête base | 0 pour une clé explicite | +1 `findFirst` par lecture | Négligeable |
| Tests unitaires existants | Mocks de `db` sans `acquisitionGmailConnection.findFirst` avec une clé explicite fictive | Échec de ces mocks | Il faut compléter les mocks (`message-content.service.test.ts`, `attachment-download.service.test.ts`) |
| Boîte inactive de la bonne société | `GMAIL_NOT_CONNECTED` (adaptateur) | Inchangé si le contrôle porte seulement sur l'appartenance, pas sur `active` | Garder ce périmètre |
| LOT-4B flag posé | Déjà corrigé (`MAILBOX_NOT_OWNED`) | Les deux chemins convergent | Aligner les codes |

## Recette du correctif (à venir)
1. Modifier uniquement les assertions « comportement actuel à corriger » des tests défensifs.
2. Faire passer `test:acquisition` avec base jetable : 1008/1012 attendu, les 4 échecs d'extraction planifiée existant déjà sur `main`.
3. Vérifier que le flag LOT-4B coupé et le flag posé donnent le même code pour D2.

## Correctif appliqué (24/11/2026)

Code unique pour les deux chemins (flag LOT-4B coupé et posé), dans `resolveMailArtifactProvider` (`resolveOwnedMailbox`) :

- **D2** : après la résolution historique, une clé de boîte explicite doit désigner une boîte de la société du message (`findFirst {id, companyId}`), sinon `ARTIFACT_CAPABILITY_UNAVAILABLE` / `MAILBOX_NOT_OWNED`.
  - Non repris pour les pièces, `CONFIG_TENANT` pour le contenu.
  - Aucun jeton n'est lu et aucun appel distant n'a lieu.
  - Le contrôle porte sur l'appartenance seule : une boîte inactive de la bonne société garde son échec `GMAIL_NOT_CONNECTED`.
  - C'est le même refus que le chemin flag posé.
- **D1** : toute exception de la résolution (lecture des boîtes, vérification d'appartenance) rend `ARTIFACT_RESOLUTION_FAILED`.
  - Pièce : `FAILED`, réservation levée, reprise planifiée.
  - Contenu : `RETRYABLE`.
  - Les workers ne lèvent plus d'exception à ce stade.
- **Journal** : flag coupé, une lecture réussie reste silencieuse ; refus et pannes sont journalisés sans valeur (`acquisition.artifact_resolution`).
- **Tests** : `artifact-historical-defects.pg.test.ts` réécrit pour le comportement corrigé, chaque cas joué sur les deux chemins (14/14). Il couvre la reprise complète d'une pièce après panne : `FAILED` → pas de reprise avant l'échéance → `DISCOVERED` à l'échéance → `STORED` par la bonne boîte.
- **Mocks complétés** (`acquisitionGmailConnection.findFirst`) : `attachment-download.service.test.ts`, `message-content.service.test.ts`. Tests unitaires du résolveur mis à jour (`artifact-resolution-flag.test.ts`, 7/7).

Compatibilité constatée :
- une requête de plus par lecture pour une clé explicite ;
- chaque panne d'infrastructure compte un essai (`downloadRetryCount`) : une très longue panne de base peut atteindre `maxRetries`. C'est le comportement voulu par la politique de reprise PLAN-ACQ-004D, à surveiller.
