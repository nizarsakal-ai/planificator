# SPEC-BILLING-C6 — Corrections du Lot C après revue Codex (7 P1 + 4 P2)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement (branche `fix/billing-c-codex-corrections`, base `68b2504`) — cycle R2 (revue Codex NO-GO sur `27808b8`, constats R1–R5) intégré ; en attente de nouvelle revue Codex ; verdict de référence NO-GO non levé par ce document |
| **Source** | `CODEX_REVIEW_LOT_C.md`, `MANDAT_CLAUDE_CORRECTIONS_LOT_C.md` et `CODEX_REVIEW_CORRECTIONS_LOT_C.md` (NO-GO R1–R5) du 26/10/2026 |
| **Drapeaux** | inchangés (`BILLING_COMPLETE_ENABLED`, `ACCOUNTING_MODULE_ENABLED`, `ACCOUNTING_AUTO_POSTING_ENABLED`, `BILLING_MAIL_ENABLED`, `BILLING_OCR_ENABLED`), tous OFF par défaut dans le code |

Cette spécification complète C1–C5 sans réécrire leur histoire : lorsqu'une règle ci-dessous contredit une formulation antérieure, la règle ci-dessous prime.

## 1. Migrations correctives (additives, ordre d'application)

| Migration | Objet |
|---|---|
| `20261026050000_billing_fix_p2_02_company_fks` | Clés uniques `(companyId, id)` et FK composites : `supplier_invoices → suppliers/supplier_invoice_files`, `bank_transactions → bank_statement_imports/invoice_payments/supplier_invoices`, `invoices → quotes` ; déclencheur de société sur `invoice_lines.deductsDepositId`. **Précontrôle** : tout lien inter-sociétés existant arrête la migration (`BILLING_FIX_PRECHECK`), aucune réparation automatique. |
| `20261026051000_billing_fix_p1_03_04_bank_reconciliation` | `invoice_payments.bankTransactionId` UNIQUE + FK composite ; CHECK d'état `bank_transactions_match_state_ck` (MATCHED ⇔ exactement une cible, paiement obligatoire côté client) ; index unique partiel « une facture fournisseur réglée une seule fois » ; garde des paiements étendue ; contrôle différé `bank_match_check` (lien réciproque, société, montant ; règlement fournisseur = TTC exact, VALIDATED, `paidAt`). Précontrôle des réservations orphelines et doubles règlements. |
| `20261026052000_billing_fix_p1_07_p1_01_credit_ceiling` | `invoice_credit_matches` compare aussi `deductsDepositId` ; `invoice_payments_total_check` devient le contrôle **central de l'origine** (paiements, contre-passations ET avoirs, origine résolue depuis l'événement, verrou `FOR NO KEY UPDATE`, état final) ; déclenché à l'INSERT comme à l'UPDATE ; avoir partiel sur acompte interdit en base. |
| `20261026053000_billing_fix_p2_03_document_snapshot` | Table `invoice_document_snapshots` (vendeur, acheteur, document : mentions, conditions, pied de page, chantier, références ; `schemaVersion`), immuable (déclencheur), insérable uniquement pour une pièce émise de la même société. |
| `20261026054000_billing_fix_p2_01_bank_import_identity` | `bank_transactions.externalId` (unique par société), `occurrence` (≥ 1), `identityAmbiguous`. |
| `20261026060000_billing_fix_r4_bank_collisions` (cycle R2) | `bank_transactions.tupleKey` (empreinte du tuple sans rang, indexée), `collisionOfId` (FK composite société → opération de provenance), `collisionResolution` (`DUPLICATE` / `DISTINCT`), `collisionResolvedAt`, CHECK de cohérence ; reprise : `tupleKey` = empreinte pour l'occurrence 1 ; occurrences > 1 (jamais déployées hors bases jetables) ⇒ précontrôle explicite, aucun recalcul SQL. |
| `20261026061000_billing_fix_r2_same_family_uniques` (cycle R2) | Index uniques partiels : une facture de solde (`kind INVOICE`) non annulée par devis et société ; une facture fournisseur `VALIDATED` par (société, fournisseur, numéro). **Précontrôle** : des doublons existants arrêtent la migration (`BILLING_FIX_PRECHECK`), aucune réparation automatique. |

## 2. Règles par constat

### P1-01 — Avoir total et déduction d'acompte
- La copie exacte d'un avoir total inclut le marqueur `deductsDepositId` de chaque ligne (service `createCreditNoteCore` et fonction SQL) : l'avoir d'un solde remisé avec acompte vaut exactement le solde (ex. 100 € HT, remise 10 %, acompte 45 € HT, TVA 20 % ⇒ solde 54 € TTC ⇒ avoir 54 € TTC, jamais 59,40 €).
- **Intégrité des totaux** (`src/lib/billing/document-integrity.ts`) : pour toute pièce émise, `recalcul(lignes) = totaux persistés`. PDF, TVA et écritures comptables **refusent explicitement** une pièce divergente (`DocumentIntegrityError`, `PostingError TOTALS_MISMATCH`, HTTP 409 sur le PDF) ; le tableau de bord l'exclut et la signale. Les brouillons ne sont pas contrôlés ; les pièces anciennes ne sont pas réécrites (précontrôle de reprise : `tests/billing/pg/legacy/integrity-scan.ts`).
- Solde nul (acomptes = 100 %) : soldé à l'émission ; aucune écriture, refus explicite `DOCUMENT_EMPTY` visible dans le rapport de génération.

### P1-02 — TVA sur les encaissements
Contrat (voir tableau §3) : l'événement d'exigibilité est le **mouvement de trésorerie** ; un avoir ne régularise rien tant qu'aucun remboursement n'est enregistré ; répartition par taux par **allocation cumulative** sur l'historique des mouvements de la facture (somme exacte au terme du règlement) ; contre-passation = part négative exacte ; déclaration figée ; calcul déterministe. Remboursement après avoir total : non pris en charge, signalé dans `warnings`, contre-passation refusée sur facture annulée.

### P1-03 — Rapprochement client
Une seule transaction (`runAccountingTransaction`) : verrou de l'opération → `recordPaymentCore` (verrou facture, plafond) avec `bankTransactionId` → MATCHED avec paiement et facture dans la même écriture → contrôles différés avant COMMIT. Tout refus après la première écriture lève `LifecycleAbort` (ROLLBACK). Plus de « réparation après 5 minutes ». Écriture A1 hors transaction, idempotente (source), rattrapable. Rejeu ⇒ refus sans effet.

### P1-04 — Rapprochement fournisseur
Règlement **intégral de montant exact** uniquement : sous verrou (opération puis facture fournisseur), société, VALIDATED, impayée, sens débiteur, |montant| = TTC ; MATCHED et `paidAt` dans la même transaction ; échec après réservation ⇒ exception ⇒ rollback des deux objets. Ordre des verrous documenté : opération bancaire → pièce cible.

### P1-05 — Autorité du jeton à la décision
Signature/refus par lien : verrou de la ligne portant le hachage (`SELECT … FOR UPDATE`), relecture sous verrou (hachage, expiration, validité métier, statut SENT), transition par UPDATE conditionnel incluant hachage et expiration (`guard`). Renvoi et relance partagent le protocole (UPDATE conditionnel sur la même ligne). Un renouvellement committé avant la décision invalide l'ancien lien ; le nouveau reste utilisable ; jamais deux décisions. Le jeton n'apparaît ni dans les journaux ni dans les preuves (hachage seul).

### P1-06 — Modification refusée sans effet
`updateDraftInvoice` : un refus du recalcul des déductions après remplacement lève `LifecycleAbort` ⇒ ROLLBACK (en-tête, lignes, liaisons, journal). `transitionInvoiceCore` : la transition conditionnelle précède toute autre écriture. `validateSupplierInvoice` : même règle (fournisseur créé puis refus ⇒ rollback). Règle générale (mandat §2.6) : aucune réponse d'échec après une mutation.

### P1-07 — Invariant SQL central
`paiements nets ≥ 0` et `paiements nets + avoirs partiels émis ≤ TTC` sur l'origine, pour tout événement ; statut cohérent (PAID ⇔ paiements + avoirs = TTC, PARTIAL ⇔ 0 < paiements et paiements + avoirs < TTC, SENT ⇔ aucun paiement) ; **PAID héritée sans ligne de paiement tolérée uniquement sans avoir partiel** (service : `settledOutside`, SQL : `PAYMENT_STATUS_MISMATCH`) ; avoir partiel sur acompte interdit (service + SQL) ; TOTAL/PARTIAL exclusifs ; avoir total exact toujours possible. Vérifié avec un rôle applicatif non propriétaire.

### P2-01 — Identité des opérations bancaires
Identifiant bancaire stable (`bankId` du mapping) ⇒ identité certaine ; sinon tuple + rang d'occurrence dans le fichier ; une ligne dont le tuple est répété est **ambiguë** : conservée, jamais rapprochée automatiquement, résolution manuelle explicite. Réimport ⇒ 0 ajout ; relevés chevauchants ⇒ multiplicité = maximum observé, aucune suppression. Limites documentées (DECISIONS) : une nouvelle opération réellement identique à une opération d'un relevé précédent, sans identifiant bancaire, n'est reconnue que si son nombre d'occurrences dans le fichier dépasse celui déjà connu ; recommandation : choisir la colonne d'identifiant bancaire.

### P2-02 — Isolation imposée en base
FK composites (§1) ; les services conservent leurs contrôles et renvoient « introuvable » sans mutation ; les actions refusent tout `companyId` client (schémas stricts).

### P2-03 — Réédition fidèle
Snapshot structuré versionné à l'émission (facture, acompte, avoir — y compris chemin Lot B) ; la réédition d'une pièce émise lit le snapshot ; brouillon ⇒ données courantes ; pièce émise **sans** snapshot (héritée) ⇒ réédition depuis les fiches actuelles avec mention explicite « snapshot historique indisponible », jamais présentée comme original certifié ; aucune reconstruction par la migration (reprise séparée, à décider). Le suivi des règlements est une **annexe** datée, distincte de la pièce.

### P2-04 — Validité des devis
`validUntil` = jour civil inclus, fuseau **Europe/Paris** ; fin de validité = premier instant du lendemain (décalage réel, heure d'été/hiver). Validité dépassée ⇒ refus de l'envoi, du renvoi, de la signature et du refus par lien, sans jeton ni courrier ; l'offre se renouvelle par **duplication** (message et bouton). Validité absente ⇒ jeton 30 jours. Jeton = fin de validité. Le cron n'intervient que pour l'expiration de statut, jamais pour la décision.

## 2 bis. Cycle R2 — constats R1 à R5 de la revue Codex du 26/10/2026 (NO-GO sur `27808b8`)

### R1 — Assiette d'allocation nette des avoirs ciblés (TVA sur les encaissements)
- L'assiette est la facture **nette de ses avoirs partiels émis**, taux par taux. Les événements d'une facture — paiements, contre-passations, avoirs (partiels et total) — sont ordonnés (jour ; avoir avant paiement le même jour ; création ; identifiant). Pour chaque événement : cible(taux) = arrondi(min(cumul encaissé, TTC net) × montant net du taux / TTC net) ; part = cible − déjà attribué.
- Un avoir émis **après** des encaissements produit une **réaffectation par taux datée de l'avoir** (parts positives/négatives dont la somme suit la ventilation nette), jamais une réécriture d'une période antérieure ; elle est comptée dans `adjustments` (TVA, déclaration). Un avoir partiel ne porte jamais sur une somme encaissée (plafond C4 : avoir ≤ reste à payer) : la réaffectation ne régularise que la ventilation par taux d'un encaissement conservé, pas une restitution.
- Oracle de référence (reproduction Codex) : A 100 € HT @20 % + B 100 € HT @10 % ; avoir annulant A ; encaissement des 110 € restants ⇒ **10,00 € au taux 10 %, 0 au taux 20 %**. Inverse, plusieurs avoirs, paiement partiel avant/après l'avoir, périodes distinctes : `tests/billing/fix/pg/r1-vat-credit-allocation.pg.test.ts`.
- Hors contrat (inchangé, précisé) : encaissement conservé au-delà de la facture nette (avoir total après paiement, données héritées) ⇒ allocation **gelée** pour la facture (aucune part, même négative), `warnings` cite le montant ; la déclaration de la période est refusée (R5).

### R2 — Émission par le chemin Lot B : verrou avant lecture
- `transitionInvoiceCore` et `createCreditNoteCore` verrouillent la facture (`SELECT … FOR UPDATE`, injectable) **avant** la lecture qui nourrit le recalcul/la copie : même protocole que la modification des lignes (UPDATE conditionnel) et que l'émission Lot C. Une modification concurrente du brouillon attend ou a déjà commité : les totaux écrits à l'émission sont ceux de la version finale (reproduction Codex : 240 € stockés = 240 € recalculés, jamais 120/240).
- Tests : cœur réel et Server Action `updateInvoiceStatus` (drapeaux OFF, session simulée), ordres modification→émission et émission→modification.

### R3 — Instant de décision relu après le verrou
- `src/lib/billing/clock.ts` : horloge serveur contrôlable (`serverNow`, `decisionInstant(start, clock)` = max(début de requête, horloge relue)). Signature et refus par lien, renvoi (`sendQuote`) et relances évaluent l'expiration du jeton, la validité métier et la garde atomique à l'instant **relu après l'acquisition du verrou** ; `signedAt`/`refusedAt`/`sentAt` portent cet instant.
- Tests : expiration naturelle pendant l'attente (aucune colonne modifiée, horloge réelle), refus, décision à temps, passage du jour métier (horloge ancrée + temps réel écoulé), renvoi, horloge non monotone.

### R4 — Collisions d'identité bancaire entre fichiers
- Sans identifiant bancaire, une ligne dont le tuple est **déjà connu d'un relevé antérieur** n'est plus éliminée : elle est conservée (PENDING, `identityAmbiguous`, occurrence = maximum connu + rang dans le fichier, `collisionOfId` = occurrence la plus ancienne connue) en attente d'une **résolution explicite et tracée** : `DUPLICATE` ⇒ IGNORED (note de provenance) ; `DISTINCT` ⇒ rapprochable (reste ambiguë seulement si son tuple est répété dans son propre relevé). Résolution par ligne ou pour tout un relevé (relevés qui se chevauchent). Ni rapprochement automatique, ni manuel, ni « ignorer » avant résolution. `duplicates` ne compte plus que les doublons **certains** (identifiant bancaire déjà importé) ; `collisions` compte les lignes à résoudre.
- Règle P2-01 « multiplicité = maximum observé » **remplacée** par cette règle (un chevauchement n'est jamais présumé).

### R5 — Déclaration de TVA : refus explicite des cas hors contrat
- `declareVat` refuse (`ok: false`, avertissements cités) toute période dont le calcul produit un `warnings` ; aucune ligne DECLARED, aucun journal ; le bouton est désactivé avec le motif (règle appliquée côté serveur). Aucun workflow d'exception dans ce lot (décision Nizar/expert-comptable requise).
- Une déclaration enregistrée archive le contrôle dans `details` (`warnings: []`, `outOfContractChecked: true`, `adjustments`).
- Même famille : contrôle d'unicité, de chevauchement, calcul et écriture dans **une transaction SERIALIZABLE** (rejouée sur conflit) : instantané cohérent ; périodes chevauchantes refusées ; période non terminée (dernier jour ≥ aujourd'hui, horloge serveur) refusée.

### Même famille (audit interne du cycle R2, corrigés)
- Acompte et émission du solde sérialisés par le verrou du devis ; un acompte ne s'émet jamais après l'émission du solde (`deposit.service.ts`).
- Une seule facture de solde non annulée par devis (contrôle sous verrou du devis + index unique partiel ; violation traduite « Ce devis est déjà lié à une facture. »). **Ordre global des verrous** : facture → devis → acomptes (documenté dans `deposit.service.ts`).
- Une seule facture fournisseur validée par (fournisseur, numéro) (index unique partiel + verrou consultatif par nom de fournisseur sans SIRET).
- Courrier de renvoi bâti sur les données relues sous verrou ; relance conditionnée au hachage lu (un renvoi concurrent n'est jamais écrasé) et à l'instant courant.
- Non corrigés, documentés (DECISIONS du cycle R2) : date d'émission/série annuelle calculées en UTC avant verrou (B1/B2), déductions d'acompte orphelines après retrait du devis d'un brouillon (A3), contrôles d'émission et snapshot lus dans des instructions distinctes (A7), relances de factures sur reste dû lu avant réclamation (A8), fusion des lignes d'import de devis par référence (D1), fichier fournisseur déjà présent non bloquant (D2/E1), export FEC servi malgré SIREN manquant (E2), rapprochement automatique sur « montant exact » lu hors verrou (E3), acceptation manuelle d'un devis périmé (B5).

## 3. TVA sur les encaissements — table des règles

| Cas | Règle appliquée | Fondement / statut |
|---|---|---|
| Paiement d'une facture (prestation de services) | TVA exigible à l'encaissement ; part par taux = allocation cumulative (prorata de la facture) | CGI art. 269-2-c (encaissements) ; règle d'allocation = choix d'implémentation garantissant la somme exacte |
| Paiements fractionnés, centimes, taux multiples | Σ parts = TVA de la facture par taux au terme du règlement ; aucune dérive | Choix d'implémentation (testé) |
| Contre-passation d'un paiement | Mouvement négatif ⇒ part négative exacte du paiement annulé, dans la période de la contre-passation | Régularisation reliée à un événement et à une base antérieure |
| Avoir (partiel/total) sans mouvement de trésorerie | Aucune TVA « négative » sur les encaissements ; l'avoir réduit le reste dû | CGI art. 272-1 : imputation/restitution conditionnée à la rectification de la facture ET à l'absence d'encaissement conservé ; BOI-TVA-DED-40-10-20 |
| Avoir après paiement partiel (partie non encaissée) | TVA déjà collectée conservée en montant total pour un taux unique ; facture multi-taux : réaffectation par taux datée de l'avoir (l'encaissement conservé couvre la facture nette) — R1 | Même fondement ; ventilation = choix d'implémentation (testé), à confirmer par l'expert-comptable |
| Avoir ciblé puis encaissement du reste (multi-taux) | Assiette nette de l'avoir : la TVA encaissée est celle des postes restants (ex. 230 − 120 = 110 € ⇒ 10 € @10 %) — R1 | BOI-TVA-BASE-20-20 (exigibilité à l'encaissement) ; oracle déduit des pièces |
| Avoir total sur facture encaissée | Non régularisé automatiquement ; avertissement ; remboursement non pris en charge | **Cas non couvert** — décision expert-comptable requise (restitution art. 272-1 après remboursement effectif) |
| Débits (option) | TVA des pièces émises par date d'émission, avoirs en négatif | CGI art. 269-2-c (option pour les débits) ; inchangé |
| Acompte encaissé | Exigible à l'encaissement (paiement de la facture d'acompte) | CGI art. 269-2-c |
| Autoliquidation | TVA nulle sur la pièce ⇒ aucune part | CGI art. 283-2 nonies |
| Périodes distinctes | Chaque mouvement dans la période de sa date ; déclaration enregistrée figée ; régularisation ultérieure dans sa propre période | Choix d'implémentation |

Sources officielles : [CGI art. 269](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000044983827), [CGI art. 272](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000031817248), [BOI-TVA-DED-40-10-20](https://bofip.impots.gouv.fr/bofip/1100-PGP.html/identifiant%3DBOI-TVA-DED-40-10-20-20170405). **Aucune validation d'expert-comptable n'a été obtenue** : ce tableau est une mise en œuvre testable des cas définis, les cas marqués « non couvert » sont refusés ou signalés, jamais inventés.

## 4. Critères d'acceptation (tests livrés)

Suites `test:billing:fix` (unitaires), `test:billing:fix:pg` (P1-01 … P2-03, puis cycle R2 : `r1-vat-credit-allocation`, `r2-legacy-issue-race`, `r3-decision-clock`, `r4-bank-collisions`, `r5-vat-declaration-guard`, `r6-same-family`), `test:billing:fix:actions:pg` (actions HTTP, session simulée), `test:billing:fix:campaign:pg` (parcours croisé + FEC, matrice des drapeaux), `tests/billing/pg/legacy/run-legacy-campaign.sh` (migration héritée synthétique, précontrôles). Index constat → test → invariant : `MATRICE-11-CONSTATS.md` (cycle 1) et `MATRICE-R1-R5.md` (cycle R2) des dossiers de restitution.
