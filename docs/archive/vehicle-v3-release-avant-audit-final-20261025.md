# RB-PLAN-VEH-001 — Mise en production Véhicules V3 (documents, dépenses, tournées, imports)

| Champ | Valeur |
|-------|--------|
| **Identifiant** | `RB-PLAN-VEH-001` |
| **Titre** | Recette fournisseurs réels puis mise en production contrôlée de Planificator Véhicules V3 |
| **Propriétaire fonctionnel** | Autorité produit Planificator (Nizar) ; exécution ops par une session humaine autorisée |
| **Environnements** | Vercel équipe `team_cQEbgzlFJ9J6C2aDTXOhLOxM` ; staging `prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD` ; production `prj_06FRa8dOdmHA8dD4QSIAqh0pTE8y` |
| **Base Git de référence** | `c5a6c481620204e62a414c92aea46903259f4c02` (base : 53 migrations ; livraison : 60, dont 7 nouvelles V3) |
| **État** | Dossier **préparé pour revue**, non exécuté en production. Les essais réels sont reportés à la demande de Nizar ; aucune release automatique. Reprise documentaire du 2026-10-25 : voir §9. |
| **Date de création** | 2026-10-24 |
| **Dernière validation** | 2026-10-25 (relecture documentaire ; code corrigé non déployé ; exécution production non effectuée) |
| **Prochaine revue** | avant toute exécution du palier P3 |
| **Liens** | `docs/planificator-v3-integration.spec.md`, `docs/vehicule-v3-lot1-documents.spec.md`, `docs/constitution/ENGINEERING-STANDARD-001.md`, `docs/runbooks/README.md`, `.mission/DELIVERY-REAL.md` |

Ce runbook **ne déploie rien**, **n'exécute aucune migration**, **n'active aucun drapeau** et **ne contient aucune valeur secrète**. Il décrit l'ordre, les preuves attendues et les conditions d'arrêt. Les actions de production demandent une autorisation explicite couvrant la migration, le déploiement et l’activation ; la préparation et les tests locaux sont déjà autorisés.

---

## 0. Interdits et principes

- Pas de commit, push, merge, déploiement, migration ou activation sans autorisation explicite **pour l'action concernée**.
- Pas de `prisma db push` (il omet CHECK, index partiels et triggers). Uniquement `prisma migrate deploy` sur un historique complet.
- Jamais de `DROP` ni de migration « inverse » destructive en rollback : le repli applicatif est **drapeau OFF**. Les tables additives restent en place. Les triggers posés par les migrations V3 sur les tables existantes (`trucks`, `assignments`, `employee_assignments`, `mileage_trips`, voir §1.1) continuent de s'exécuter quel que soit l'état du drapeau ; le drapeau ne rend ni les tables ni les triggers inertes.
- Secrets via un gestionnaire sécurisé ou un environnement de développement dédié. Jamais dans git, dans un rapport, ni dans un prompt.
- Configurer les drapeaux avec la valeur `true` sans espaces ; les laisser absents ou à `false` avant activation.
- Les fournisseurs externes (Cloudinary, Anthropic, OSRM, géocodage) entraînent des coûts réels. Leur activation est un palier distinct, précédé d'une recette réelle à budget borné.
- Un document historique de test ne prouve pas l'état déployé : chaque palier produit sa propre preuve datée.

---

## 1. Inventaire : code, migrations, variables

### 1.1 Migrations nouvelles (7) — toutes additives

| Migration | Contenu | Points d'attention |
|-----------|---------|--------------------|
| `20261024180000_vehicle_expenses_v3` | tables dépenses, imputations, commandes ; triggers de garde et d'immuabilité | triggers sur tables nouvelles uniquement |
| `20261024183000_vehicle_tours_v3` | tournées, étapes, commandes ; triggers | **ajoute des triggers sur tables existantes** `trucks`, `assignments`, `employee_assignments`, `mileage_trips` (gardes de planification) |
| `20261024190000_vehicle_address_imports` | table imports d'adresses | — |
| `20261024190100_vehicle_import_immutability` | trigger source immuable | — |
| `20261024190200_vehicle_import_state_machine` | machine d'états SQL imports, fenêtres quota fournisseur | — |
| `20261025120000_vehicles_v3_documents` | 5 tables documents, type `VehicleDocumentCategory`, index composite sur `vehicle_maintenance_entries`, triggers | **`ALTER TYPE "NotificationType" ADD VALUE` ×2 hors transaction, sans borne de verrou** ; puis bloc `BEGIN … COMMIT` avec `SET LOCAL lock_timeout = '5s'` qui ne couvre que ce bloc |
| `20261025130000_vehicles_v3_integration` | valeur `EXPENSE_RECEIPT`, index unique et FK composites dépenses → versions de document / interventions | **`ALTER TYPE … ADD VALUE` hors transaction, sans borne de verrou** ; puis bloc transactionnel avec `SET LOCAL lock_timeout = '5s'` |

Aucune de ces migrations ne contient de `DROP`, de suppression de colonne, ni de backfill. Les `ALTER TYPE … ADD VALUE IF NOT EXISTS` sont idempotents à la relecture, mais ce runbook **ne garantit pas** l'atomicité d'un fichier qui enchaîne une instruction hors transaction et un bloc transactionnel : un échec entre les deux laisse des valeurs d'énumération ajoutées et une migration marquée en échec par Prisma. Ce cas n'est pas couvert par une procédure de reprise automatique ; il est traité au §3 ROLLBACK comme un arrêt avec décision humaine.

**Budget de verrou.** `SET LOCAL lock_timeout` est transactionnel : il ne borne pas les `ALTER TYPE … ADD VALUE` qui le précèdent dans le même fichier. Ces instructions attendent leur verrou sur le type sans limite définie par le SQL livré. Avant toute exécution future, un budget de verrou **au niveau de la session** doit être prouvé sur l'environnement visé (par exemple en vérifiant, sur staging, la valeur effective de `lock_timeout` vue par la session qui exécute `migrate deploy`). Ce runbook n'affirme pas que `PGOPTIONS` ou un paramètre d'URL est honoré par Prisma : cette hypothèse reste à démontrer par une preuve datée. Aucun fichier SQL déjà rédigé n'est modifié pour cela.

### 1.2 Variables d'environnement (NOM uniquement)

| Variable | Rôle | Valeur palier P1–P2 | Palier d'activation |
|----------|------|---------------------|---------------------|
| `PLANIFICATOR_VEHICLES_V3_ENABLED` | drapeau maître : routes, pages, cron V3 (404 sinon) | absent / OFF | P4 |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` **ou** `CLOUDINARY_URL` | stockage privé documents et sources d'import | présence à vérifier dans la cible | P3 (recette) |
| `VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX` | préfixe dossier documents (défaut `planificator`) | absent | P4 (laisser le défaut en production) |
| `VEHICLE_DOCUMENT_MAX_BYTES` | taille max fichier (livraison intégrée : 4 Mio) | absent | — |
| `PLANIFICATOR_TRUSTED_ORIGINS` | origines supplémentaires acceptées (coque mobile) | absent | P4 si nécessaire |
| `CRON_SECRET` | Bearer de `/api/cron/vehicle-document-reminders` (déjà utilisé par les crons existants) | présent, **rotation documentée §6** | — |
| `ANTHROPIC_API_KEY`, `ACQUISITION_EXTRACTION_MODEL` | OCR imports (modèle allowlisté, défaut `claude-haiku-4-5`) | présence à vérifier dans la cible ; modèle vide ou allowlisté | P3 (recette) |
| `PLANIFICATOR_VEHICLE_OCR_ENABLED`, `PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK` | double drapeau OCR + consentement par fichier | absent / OFF | P5 |
| `PLANIFICATOR_ROUTING_ENABLED`, `PLANIFICATOR_ROUTING_OSRM_URL` | estimation d'itinéraire | absent / OFF | P5 |
| `PLANIFICATOR_VEHICLE_GEOCODING_ENABLED` | géocodage des adresses confirmées | absent / OFF | P5 |

Correction livrée avec ce runbook : l'adaptateur documents et l'adaptateur sources d'import configurent désormais eux-mêmes le SDK Cloudinary (triplet **ou** `CLOUDINARY_URL`) et renvoient `DOCUMENT_STORAGE_NOT_CONFIGURED` / `SOURCE_STORAGE_NOT_CONFIGURED` (503) sans envoyer d'octet si rien n'est défini. Avant cette correction, l'adaptateur documents dépendait d'une initialisation faite par un autre module du même bundle.

### 1.3 Planification

`vercel.json` déclare `/api/cron/vehicle-document-reminders` à `0 6 * * *` (UTC). La route répond 401 sans Bearer valide et 404 `FEATURE_DISABLED` tant que le drapeau maître est OFF : son déploiement est inoffensif avant P4. Les trois tâches préexistantes de `vercel.json` sont conservées ; cette livraison ne change pas leurs drapeaux.

---

## 2. P1 — Préparation et preuves locales (sans accès production)

### PRECHECK

- `git status` propre sur la branche de livraison ; base `c5a6c48` ; diff revu indépendamment (Codex, lecture seule).
- Vérifications du dépôt exécutées et consignées avec leur sortie exacte :

```bash
npm run typecheck:vehicules
npm run test:vehicules            # V1 + V2 + V3 (inclut les tests du script de recette)
npm run test:vehicules:v3:pglite  # historique complet des migrations sur PGlite (V3_PGLITE_DIR requis)
npm run test:vehicules:v3:integration   # PostgreSQL 16 jetable, voir tests/vehicules/pg/README.md
npm run build
```

- Référence vérifiée après préparation fournisseurs (environnement Codex) : 506 tests véhicules, contrôle TypeScript et build verts. Les 14 tests PostgreSQL et le parcours navigateur de la livraison intégrée sont également validés ; les migrations ne changent pas dans cette préparation. Toute régression = STOP.

### EXPECTED_RESULT

Un rapport de preuves daté (sorties de commandes, HEAD exact). Aucune action distante.

### STOP

Typecheck ou tests en échec ; diff contenant un secret ; migration modifiée après revue.

---

## 3. P2 — Migration additive sur staging puis production (drapeau OFF)

### PRECHECK

| Élément | Attendu |
|---------|---------|
| Projet Vercel ciblé | d'abord **staging** `prj_CRp6…`, jamais la production au premier passage |
| Base de données | hôte staging distinct de la production (NOM seulement, jamais l'URL) |
| Sauvegarde | sauvegarde restaurable vérifiée avant `migrate deploy`, avec point de restauration daté ; vérifier également le PITR s’il est disponible dans le contrat |
| État Prisma | `npx prisma migrate status` : 53 appliquées, 7 en attente, aucune échouée |
| Fenêtre | faible trafic ; `SET LOCAL lock_timeout = '5s'` borne seulement le bloc transactionnel des migrations Documents/Intégration, pas leurs `ALTER TYPE … ADD VALUE` préalables ; les autres migrations acquièrent des verrous sur `trucks`, `assignments`, `employee_assignments`, `mileage_trips` (création de triggers) sans borne définie par le SQL |
| Budget de verrou de session | prouvé sur l'environnement visé avant exécution (§1.1) ; sans cette preuve, STOP |
| Drapeau | `PLANIFICATOR_VEHICLES_V3_ENABLED` absent ou ≠ `true` |

### CHANGE

```bash
# session humaine autorisée, DATABASE_URL du seul environnement visé, jamais collée dans un fichier
npx prisma migrate status
npx prisma migrate deploy
npx prisma migrate status   # attendu : 60 appliquées, 0 en attente
```

Ordre interne défini par les fichiers : valeurs d'énumération d'abord (hors transaction), puis bloc transactionnel. Cet ordre n'équivaut pas à une exécution atomique du fichier (§1.1). Ne pas découper les fichiers à la main.

### VALIDATION

- `migrate status` sans migration en attente ni échouée.
- Assertions finales des migrations Documents (bloc `DO $$ … $$` de contrôle) passées sans erreur.
- Application déployée **sans** le drapeau : `/vehicules/<id>` onglets V3 absents ; `GET /api/trucks/<id>/documents` → 404 `FEATURE_DISABLED` ; cron rappels → 404 `FEATURE_DISABLED` avec Bearer valide, 401 sans.
- Parcours V1/V2 (parc, kilométrage, entretien) inchangés sur staging.

### ROLLBACK

- Migration échouée (avant ou pendant le bloc transactionnel) : **STOP**. Consigner la sortie exacte de `prisma migrate status` et l'erreur. Constater l'état réel : valeurs d'énumération déjà ajoutées ou non, objets créés ou non, ligne de migration marquée en échec. La suite (correction, marquage dans la table des migrations, rejeu) est une décision humaine prise sur ces constats ; ce runbook ne prescrit aucune commande de reprise automatique.
- Migration appliquée mais régression constatée : **ne rien supprimer**. Laisser les tables en place ; drapeau OFF (déjà le cas). Le drapeau OFF n'arrête pas les triggers posés sur les tables existantes : une régression V2 due à un trigger se traite comme un incident avec revue (§5 ROLLBACK point 5). Restauration PITR uniquement si corruption de données existantes, décision humaine avec le snapshot pris avant.
- Aucune migration de retour arrière n'est fournie ni autorisée.

### Puis production

Rejouer PRECHECK → CHANGE → VALIDATION sur `prj_06FR…` **uniquement** après validation staging complète (§3 et §4) et autorisation explicite pour la production.

---

## 4. P3 — Recette fournisseurs réels (budget borné, données synthétiques)

Script : `scripts/verification/vehicle-v3-real-providers.ts` (npm `verify:vehicules:v3:real-providers`). Il exerce les **adaptateurs applicatifs réels** (`document-storage.port`, `import-storage`, `extractImport` multimodal), refuse sans accusé explicite, n'a besoin d'aucune base de données et exige un environnement contenant **uniquement** les variables du service testé.

### 4.1 Stockage Cloudinary (compte de recette ou préfixe isolé du compte réel)

```bash
PREFIX="recette-$(date +%Y%m%d)-$(openssl rand -hex 4)"
env -i PATH="$PATH" HOME="$HOME" \
  CLOUDINARY_CLOUD_NAME="$CLOUDINARY_CLOUD_NAME" CLOUDINARY_API_KEY="$CLOUDINARY_API_KEY" CLOUDINARY_API_SECRET="$CLOUDINARY_API_SECRET" \
  npx tsx scripts/verification/vehicle-v3-real-providers.ts --mode storage --prefix "$PREFIX" \
  --ack I_ACCEPT_REAL_PROVIDER_COSTS --out "/tmp/recette-storage-$PREFIX.json"
```

Étapes et preuves attendues (toutes `PASS`, `cleanup.leftovers` vide) :

| Étape | Preuve |
|-------|--------|
| `storage.config` | source `triplet` ou `url`, aucune valeur |
| `storage.store-v1` | `created: true`, clé sous `PREFIX/` |
| `storage.read-signed-v1` | lecture par URL signée via le helper du proxy applicatif ; octets et SHA-256 identiques |
| `storage.unsigned-refused` | URL non signée ≠ 200 et contenu non divulgué |
| `storage.expired-signature-refused` | une signature expirée est refusée (réponse 4xx) alors que le fichier existe |
| `storage.replay-same-key` | même clé rejouée → `created: false` |
| `storage.immutable-overwrite-refused` | octets différents sur la même clé → refus, contenu d'origine intact |
| `storage.store-v2-replacement` | seconde version créée ; v1 et v2 coexistent, immuables |
| `storage.destroy-and-absence` | suppression des **deux objets exacts** puis 404 sur URL signée ; seconde suppression tolérée |
| `import-storage.roundtrip` | aller-retour `storeImportSource`/`readImportSource`, URL non signée refusée, suppression exacte, `SOURCE_UNAVAILABLE` ensuite |

Le script ne liste ni ne supprime jamais de dossier. Le rapport JSON ne contient ni clé, ni URL, ni nom de cloud, ni message fournisseur brut.

Limite connue : `import-storage` écrit sous un préfixe fixe `vehicle-imports/<empreinte entreprise>/<empreinte camion>/`, hors `VEHICLE_DOCUMENT_CLOUDINARY_FOLDER_PREFIX`. Les identifiants synthétiques de la recette rendent ces objets uniques ; ils sont supprimés par identifiant exact.

### 4.2 OCR Anthropic (2 appels réels maximum)

```bash
env -i PATH="$PATH" HOME="$HOME" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  npx tsx scripts/verification/vehicle-v3-real-providers.ts --mode ocr \
  --ack I_ACCEPT_REAL_PROVIDER_COSTS --out /tmp/recette-ocr.json
# variante avec la fixture Codex :
#   --fixture tests/fixtures/vehicules/v3-addresses-synthetic.png \
#   --expect-address "12 rue des Lilas 75012 Paris" --expect-address "8 avenue des Fleurs 31000 Toulouse"
```

| Étape | Preuve |
|-------|--------|
| `ocr.config` | modèle allowlisté (défaut `claude-haiku-4-5`) ; aucun repli silencieux |
| `ocr.gate-flags-off` | sans les deux drapeaux : `OCR_NON_PRET_SAISIE_MANUELLE`, **0 appel** |
| `ocr.gate-consent-off` | drapeaux ON mais sans consentement fichier : **0 appel** |
| `ocr.text-pdf-deterministic-no-call` | PDF texte : adresses trouvées sans fournisseur, **0 appel** |
| `ocr.real-image-png` | 1 appel ; ≥ 2 candidats ; les deux adresses connues présentes avec extrait de preuve ; `confirmed: false`, coordonnées nulles ; avertissements `OCR_A_VERIFIER` + `REVUE_HUMAINE_REQUISE` |
| `ocr.real-document-pdf-image-only` | 1 appel sur PDF sans texte (voie `document`) ; mêmes invariants |
| `ocr.human-confirmation-gate` | approbation refusée tant que `confirmed` n'est pas `true` : `HUMAN_CONFIRMATION_REQUIRED` |
| `ocr.call-budget` | `calls ≤ 2`, aucun refus local, jetons entrée/sortie consignés |

Budget : le plafond est appliqué **localement avant tout envoi** ; un troisième appel est refusé par le script. Les jetons consommés figurent dans `ocr.inputTokens` / `ocr.outputTokens` du rapport.

### STOP

Toute étape `FAIL` ; `cleanup.leftovers` non vide (objet de recette resté sur le compte : supprimer **par identifiant exact** depuis la console, jamais par dossier) ; rapport contenant une valeur ressemblant à une clé ou une URL (défaut de redaction = STOP et correction avant toute activation).

Les rapports JSON sont les preuves de ce palier. Sans rapport `PASS` daté, **P4 n'est pas autorisé**.

---

## 5. P4 — Activation contrôlée du drapeau maître

### PRECHECK

P2 validé sur l'environnement visé ; P3 `PASS` (stockage) ; aucune variable OCR/routage/géocodage à `true` ; `CRON_SECRET` présent ; accès admin de recette disponible.

### CHANGE (staging d'abord, puis production après autorisation distincte)

1. `PLANIFICATOR_VEHICLES_V3_ENABLED=true` dans l'environnement Vercel visé (valeur exacte).
2. Nouveau déploiement du même commit avec la configuration d’environnement visée ; vérifier son identifiant, sa cible et ses variables avant promotion.

### VALIDATION (recette fonctionnelle avec données fictives)

- Administrateur : fiche camion → onglets Documents, Tournées, Coûts, Imports visibles ; ajout d'un document PDF synthétique (≤ 4 Mio), consultation via le proxy privé, remplacement, validation humaine, archivage.
- Chef d'équipe affecté : lecture CT/entretien/assurance ; carte grise masquée **et** refusée côté API ; écriture refusée.
- Employé/chauffeur/client : 403 sur toutes les routes V3.
- Import : fichier texte synthétique → candidats non confirmés → approbation refusée sans confirmation → approbation après confirmation → consommation par une tournée.
- Cron : `GET /api/cron/vehicle-document-reminders` avec Bearer → 200 et résumé ; rejeu → aucun doublon de rappel.
- Journaux Vercel : aucune URL signée, aucun secret, aucun message fournisseur brut.

### ROLLBACK (sans DROP)

1. Identifier les tournées V3 actives avant repli. Si possible les clôturer par le parcours V3 ; sinon documenter leur gel et prévoir leur reprise sur une version V3 corrigée. Les gardes SQL empêchent une ancienne application V2 de clôturer directement un trajet lié.
2. `PLANIFICATOR_VEHICLES_V3_ENABLED` → absent ou `false`, redéploiement. Routes et pages V3 → 404 ; cron → `FEATURE_DISABLED`.
3. Les tables V3 et leurs données restent en place. **Aucune suppression.** Les triggers V3, y compris ceux posés sur `trucks`, `assignments`, `employee_assignments` et `mileage_trips`, restent actifs après le repli ; le drapeau ne les désactive pas.
4. Les objets Cloudinary déjà créés restent privés (authenticated) ; pas de purge automatique.
5. Si des triggers de tournées bloquent une écriture V2 légitime pendant le repli : traiter comme incident, **ne pas** supprimer les triggers à chaud sans revue ; les gardes n'agissent que sur des lignes liées à des tournées actives.

---

## 6. P5 — Fournisseurs optionnels et secret cron

### 6.1 `CRON_SECRET`

- Secret déjà requis par les crons existants ; il protège aussi le cron de rappels V3.
- Rotation : générer une nouvelle valeur (≥ 32 octets aléatoires), la poser dans Vercel pour l'environnement visé, redéployer, puis mettre à jour l'ordonnanceur appelant (Vercel Cron utilise automatiquement la valeur courante ; un ordonnanceur externe doit être mis à jour avant l'ancienne valeur ne soit révoquée).
- Ne jamais écrire la valeur dans git, un ticket ou un rapport.

### 6.2 OCR (coût par appel Anthropic)

Préconditions : P3 OCR `PASS` ; budget mensuel décidé et consigné hors git ; modèle allowlisté choisi (`ACQUISITION_EXTRACTION_MODEL` vide = `claude-haiku-4-5`). Gardes en place dans le code : consentement par fichier, double drapeau, 20 pages max, 4 Mio max, délai 15 s/20 s, sortie bornée à 60 000 octets, quota entreprise 20 imports/jour, JSON strict, candidats jamais confirmés automatiquement.

CHANGE : `PLANIFICATOR_VEHICLE_OCR_ENABLED=true` **et** `PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK=true`. ROLLBACK : retirer l'un des deux → `OCR_NON_PRET_SAISIE_MANUELLE`, aucun appel.

### 6.3 Routage et géocodage

`PLANIFICATOR_ROUTING_ENABLED=true` + `PLANIFICATOR_ROUTING_OSRM_URL` (instance contrôlée) ; `PLANIFICATOR_VEHICLE_GEOCODING_ENABLED=true` + consentement. Quota persistant 60 appels/heure/entreprise/fournisseur (`vehicle_import_provider_windows`). Aucune recette réelle de ces deux fournisseurs n'est fournie par ce runbook : palier distinct à préparer avant activation.

---

## 7. Risques résiduels

| Risque | Mitigation |
|--------|------------|
| Triggers V3 posés sur des tables V2 existantes (tournées), actifs même drapeau OFF | migration sur staging d'abord ; parcours V2 revalidé drapeau OFF ; sauvegarde restaurable avant production |
| `ALTER TYPE … ADD VALUE` exécutés sans borne de verrou (le `lock_timeout` transactionnel ne les couvre pas) | budget de verrou de session prouvé sur l'environnement visé avant exécution (§1.1) ; fenêtre de faible trafic |
| Échec entre l'instruction hors transaction et le bloc transactionnel d'un même fichier | pas de reprise automatique ; constat d'état et décision humaine (§3 ROLLBACK) |
| Objets Cloudinary orphelins après échec de rattachement | compensation de l'objet unique créé ; journal `storage reconciliation required` à surveiller ; suppression manuelle par identifiant exact uniquement |
| Coût fournisseur OCR | double drapeau + consentement + quotas ; budget consigné ; rapport P3 avec jetons |
| Limite Vercel 4,5 MB sur l'enveloppe multipart | plafond applicatif 4 Mio ; fichiers plus lourds hors périmètre |
| Rotation `CRON_SECRET` désynchronisée d'un ordonnanceur externe | procédure §6.1 ; vérifier 401 → 200 après rotation |
| Typecheck local dépend d'un client Prisma régénéré | exécuter `prisma generate` dans l'environnement de vérification avant `typecheck:vehicules` |

---

## 8. Preuves historiques du 24 octobre (supplantées par §9 pour la reprise)

| Preuve | État au 2026-10-24 |
|--------|---------------------|
| Tests unitaires V3 (`npm run test:vehicules:v3`) | 110 réussis, dont 21 pour la recette et la configuration Cloudinary ; V2 : 177, V1 : 219, soit 506 au total |
| Typecheck véhicules | réussite complète dans la copie intégrée avec client Prisma à jour |
| Livraison intégrée (Codex) | 506 tests unitaires et compilation finale réussis ; 14 PostgreSQL et navigateur précédemment validés, aucune migration modifiée |
| Recette stockage réelle (P3) | **non exécutée** par la préparation ; reportée à la demande de Nizar ; rapport JSON PASS à obtenir avant activation |
| Recette OCR réelle (P3) | **non exécutée** par la préparation ; reportée à la demande de Nizar ; rapport JSON PASS à obtenir avant activation |
| Migration staging / production (P2) | **non exécutée** |
| Activation (P4/P5) | **non exécutée** ; V3 reste un prototype désactivé |

**Décision du 24 octobre : préparer le dossier sans appels réels. Cloudinary et OCR non validés sur les services réels.**

**Statut : NO-GO production tant que P2 staging, P3 (rapports `PASS`) et P4 staging ne sont pas prouvés et autorisés.**

---

## 9. Reprise du 25 octobre 2026

### 9.1 Incident Neon : clos

L'incident ouvert sur la base Neon est clos. Les preuves retenues sont une connexion effective vérifiée sur la base concernée et une comparaison Time Travel entre l'état avant et après la fenêtre d'incident. Aucune restauration Neon n'a été effectuée dans le cadre de cette reprise. Les documents historiques de tests ne tiennent pas lieu de preuve de l'état déployé : seules les deux preuves ci-dessus sont retenues pour la clôture.

### 9.2 Périmètre réellement activé

- V3 n'a été active que dans une préproduction antérieure. Aucune activation en production.
- Stockage Cloudinary réel et OCR réel : reportés ; les paliers P3 et P5 restent non exécutés.
- Les corrections de code décrites en §9.3 ne sont **pas déployées** : aucun déploiement, aucune migration distante, aucun changement Git dans cette reprise. Les 60 migrations ont été rejouées sur une nouvelle base PostgreSQL locale de recette.

### 9.3 Corrections de code relues (non déployées)

- `src/lib/vehicules/v3/document-service.ts` : dans la validation humaine, les gardes « dossier archivé » et « version courante » précèdent désormais la reconnaissance du rejeu ; dans l'archivage, un rejeu n'est reconnu que si l'acteur, la révision attendue **et** le motif normalisé (trim) sont identiques, sinon `DOCUMENT_ARCHIVED`.
- `tests/vehicules/v3/v3-migration.pglite.test.ts` : la sélection des triggers du lot Documents cible les quatre relations concernées (`vehicle_audit_logs`, `vehicle_document_reminders`, `vehicle_document_versions`, `vehicle_documents`) au lieu d'un filtre sur le nom contenant `v3`, qui englobait aussi les triggers légitimes des dépenses et des tournées.
- `tests/vehicules/document-fixes.pg.test.ts` : nouvelle régression PostgreSQL couvrant le rejeu de validation périmé et l'archivage rejoué avec un motif différent, sans écriture ni audit supplémentaires.
- Aucune migration déjà rédigée n'est modifiée.

### 9.4 Preuves courantes (transmises par Codex, non ré-exécutées ici)

| Preuve | État transmis au 2026-10-25 |
|--------|-----------------------------|
| Tests unitaires et pages véhicules | 515 passés |
| Rejeu PGlite de l'historique complet des migrations | passé |
| Nouveaux tests PostgreSQL documents (`document-fixes.pg.test.ts`) | passés |
| Sept suites PostgreSQL V2/V3 : documents, coûts, imports, tournées, intégration | 15 tests passés, aucune omission ; base V3 locale neuve avec 60 migrations |
| Contrôle TypeScript et compilation complète | réussis |
| Navigateur | parcours de rétablissement production vérifiés dans le dossier Neon ; pas de nouvelle recette fournisseurs V3 |

Ces chiffres ont été exécutés par Codex. La revue indépendante Claude est statique et ne les a pas reproduits. Pour la recette PostgreSQL intégrée, seules les destinations autorisées des copies de tests ont été adaptées à une nouvelle base locale complète ; les assertions sont inchangées. Les anciennes bases par lot sont conservées. Une tentative de migration sur l’ancienne base coûts a rencontré une fixture historique invalide pour la nouvelle FK : aucun marquage forcé ni suppression de données n’a été effectué ; cette base ne constitue plus la référence de recette. Ils ne valent ni preuve de déploiement ni preuve d'exécution des paliers P2 à P5.

## Références fournisseurs

- Configuration du SDK : [Cloudinary Node.js](https://cloudinary.com/documentation/node_integration).
- Fichiers privés et liens temporaires : [Cloudinary access control](https://cloudinary.com/documentation/control_access_to_media). Le téléchargement temporaire passe par l’API et consomme davantage de bande passante selon cette documentation ; son coût réel dépend du contrat.
- Images et PDF base64 : [Claude Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [Claude PDF](https://platform.claude.com/docs/en/build-with-claude/pdf-support).


## 10. Recette réelle et préparation de publication — 25 octobre 2026

La demande de Nizar du 25 octobre autorise la poursuite autonome des essais, les corrections et le déploiement après validation. Elle remplace le report des essais réels décrit dans les sections historiques.

- Stockage Cloudinary réel : 11 étapes et 27 assertions PASS, lecture signée et intégrité, refus sans signature/à expiration, remplacement immuable, suppression exacte et aucun objet restant dans la recette fournisseur. Les sources d’import passent désormais par une URL API privée expirant en 300 secondes, pour éviter la relecture d’une ancienne réponse du CDN après suppression.
- OCR Anthropic réel : image PNG et PDF scanné PASS, deux adresses de fixture retrouvées ; consentement, double drapeau et validation humaine contrôlés. Le parseur accepte un JSON complet ou un unique bloc Markdown JSON complet, sans accepter de prose ni assouplir le schéma. Les coordonnées et la confirmation restent nulles/fausses après OCR.
- Routage et géocodage : un essai public de chaque adaptateur PASS après correction des réponses HTTP compressées. Ces essais ne constituent pas un contrat de service de production ; leurs drapeaux restent OFF dans le candidat.
- Répétition Neon : copie `br-gentle-bread-alnqkysa` créée depuis la production originale sans changement de branche par défaut ni déplacement de compute. 60 migrations appliquées, aucune incomplète. Budget effectif `lock_timeout=5s` observé dans une session Prisma de preuve sur cette copie, via une connexion directe et le paramètre URL `options` ; aucune hypothèse sur `PGOPTIONS`. Les sept fichiers SQL V3 sont inchangés.
- Les rappels sont planifiés par entreprise, puis envoyés séparément avec relecture sous verrou. Recette sur la copie Neon via le pool applicatif : 17 entreprises, 16 notifications au premier passage, zéro nouvelle notification au rejeu. Les tests de concurrence déclenchent désormais les changements après le plan et avant le premier verrou d’envoi, et transmettent les options transactionnelles réelles.
- Les pages protégées et les transactions d’import utilisent un délai explicite de 15 secondes ; le plan des rappels est borné à 30 secondes par entreprise. Les liens des rubriques camion ne préchargent plus les pages protégées voisines.
- Profil candidat : V3 ON, OCR ON avec consentement par fichier et quota existant de 20 imports par entreprise sur 24 heures ; routage et géocodage OFF. Aucun appel OCR automatique au chargement d’une page.
- La copie d’application en préproduction utilise exclusivement `V3_STAGING_DATABASE_URL`. Le paquet de production doit conserver `DATABASE_URL` et vérifier le point de connexion d’origine avant toute migration ou build. Aucune route de recette privée ne doit entrer dans le paquet de production.

Ces preuves autorisent la préparation du candidat ; le rapport de publication daté doit encore consigner le déploiement effectivement livré, les parcours authentifiés et le contrôle des journaux. Les sections historiques ne constituent pas ce constat de publication.


### Complément de recette du 25 octobre 2026

La création réelle d’import a révélé un retour PostgreSQL `void` incompatible avec `$queryRaw`. Le verrou transactionnel `pg_advisory_xact_lock` utilise désormais `$executeRaw`, sans changer sa clé, sa portée ni le contrôle de quota. Une régression PostgreSQL appelle `createImport` et vérifie la réservation, son empreinte et la transition FAILED en cas de stockage indisponible. Elle passe sur PostgreSQL local et sur Neon.

Les tests PostgreSQL V3 sont regroupés dans `npm run test:vehicules:v3:pg` ; chaque fichier conserve son garde de base isolée. Pour la recette Neon, seules les copies de tests ont des gardes adaptés au projet et à la branche explicitement identifiés ; les assertions métier restent identiques. Le code produit n’est pas adapté aux tests.

Les variables du projet Vercel prennent le dessus sur les anciennes clés env du paquet : les drapeaux OCR doivent être vérifiés dans le projet cible et à l’installation. Les anciennes tentatives de migration annulées en juillet restent dans le journal d’audit ; elles ne sont pas des migrations incomplètes. La vérification de publication ignore les tentatives `rolled_back_at` et vérifie intégralement les 60 migrations appliquées.

La recette réelle de création d’import a ensuite obtenu PASS : brouillon, deux adresses non confirmées, coordonnées nulles, source privée attachée. L’approbation humaine et la publication sont consignées séparément dans le rapport daté final.

### Géocodage IGN — complément du 25 octobre 2026

Le géocodage V3 utilise IGN/Géoplateforme (BAN), sur consentement explicite à chaque demande. Variables : `PLANIFICATOR_VEHICLE_GEOCODING_ENABLED=true`, `PLANIFICATOR_GEOCODING_PROVIDER=IGN`, `PLANIFICATOR_GEOCODING_IGN_URL=https://data.geopf.fr/geocodage/search`. Le fournisseur reçoit uniquement l’adresse ; aucun document source ni nom de personne n’est nécessaire.

Migration additive 61 : cache PostgreSQL isolé par entreprise (clé contenant le hash du destinataire et de l’adresse normalisée, coordonnées seules en valeur), expiration 24 h/5 min, admission globale une requête par seconde avec horloge DB, délai de protection 60 s sur erreur. Le quota 60/h n’est débité qu’après un cache manqué et une admission réussie, dans la transaction d’autorité ; le réseau est hors transaction. La protection globale peut retarder toutes les entreprises pendant une minute en cas d’erreur fournisseur.

Recettes : sept tests adaptateur, contraintes/migrations PGlite, cache et concurrence PostgreSQL/Neon, un appel IGN réel à une place publique puis lecture du cache depuis un autre client. Les modèles Prisma des deux nouvelles tables sont déclarés. Les propositions faibles ou mal formées ne produisent aucune coordonnée ; les coordonnées ne sont jamais une validation automatique d’adresse.

Le routage reste OFF : le serveur de démonstration OSRM exclut l’usage commercial ; les endpoints IGN documentés répondent actuellement HTTP 404 et le site officiel annonce une indisponibilité temporaire. Ne pas activer une démo publique en remplacement. L’estimation manuelle et la préparation de tournée restent disponibles. Le service IGN de géocodage, distinct, passe les tests réels. Les capacités routières devront être revérifiées avant activation du routage.

Sources : https://cartes.gouv.fr/aide/fr/guides-utilisateur/utiliser-les-services-de-la-geoplateforme/geocodage/ ; https://cartes.gouv.fr/explorer-les-cartes/ ; https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server .
