# ADR-PLAN-003 — Comptabilité en partie double native, multi-société

| Champ | Valeur |
|-------|--------|
| **Statut** | Proposé |
| **Date** | 2026-10-25 |
| **Décideur** | Autorité Architecture (Nizar) — décision D1 prise par délégation explicite de Nizar à Claude le 25/10/2026, acceptation formelle après revue indépendante Codex |
| **Revue** | Codex — readiness GO_AVEC_RÉSERVES (25/10/2026), revue de cet ADR à venir |
| **Norme** | ENGINEERING-STANDARD-001 §11, §21 ; PLAN-GOVERNANCE-001 |

## Contexte

Planificator dispose d'un socle Comptabilité « Lot 0 » (flag serveur fermé par défaut, garde ADMIN de la société active, page vide) et d'un module de facturation (Quote/Invoice) qui n'offre pas les garanties d'une pièce comptable : retour possible à DRAFT après émission, course brouillon/émission, annulation sans avoir, suppression en cascade avec le chantier ou la société, calculs en nombres flottants. Le multi-société de main (65e314b) donne à chaque session un rôle et une société actifs. Galya Events est la première société cible ; la conformité fiscale (FEC, TVA, facturation électronique) devra être validée sur les textes officiels et par un expert-comptable.

## Décision

1. **Moteur de partie double interne** à Planificator, isolé dans `src/lib/accounting/`, seul habilité à créer des écritures. Les modules métier (factures, notes de frais, achats) produisent des **pièces** ; le moteur les transforme en écritures de façon idempotente.
2. **Montants exacts** : entiers en **centimes (BigInt)**, devise unique EUR au Lot A ; jamais de `number` flottant de bout en bout (entrée, calcul, stockage, sérialisation en chaîne). Arrondi TVA : par ligne au centime (demi supérieur), total = somme des lignes ; règle figée et testée.
3. **Écriture = brouillon puis validation irréversible.** Une écriture validée et ses lignes ne sont jamais modifiées ni supprimées ; toute correction se fait par **contre-passation** référencée. Garanti à la fois par le service et en base (déclencheurs refusant UPDATE/DELETE sur les écritures/lignes validées ; aucun chemin de maintenance applicatif).
4. **Numérotation** continue sans trou **par société × journal × exercice**, attribuée **à la validation** dans la même transaction, via un compteur verrouillé (`SELECT … FOR UPDATE`), contrainte unique et nouvelle tentative bornée. Pas de séquence PostgreSQL (trous après rollback).
5. **Idempotence** : clé unique `(companyId, sourceType, sourceId, sourceVersion)` + empreinte du contenu ; même clé avec contenu différent ⇒ erreur, jamais d'écrasement. Réservation, écriture, lignes, numéro, chaînage et audit dans **une seule transaction**.
6. **Isolation multi-société en base** : chaque table porte `companyId` ; clés étrangères **composites** `(companyId, id)` garantissant que journal, compte, exercice, écriture et lignes appartiennent à la même société ; `onDelete: Restrict` partout (aucune cascade sur des données comptables). Toutes les lectures et exports filtrent par la société de la session.
7. **Équilibre** : ≥ 2 lignes, débit XOR crédit par ligne, montants > 0, somme débits = somme crédits ; comptes actifs ; date comptable dans un exercice OUVERT. Contrôlé par un validateur pur et revérifié en base à la validation (déclencheur de contrainte différé sur l'écriture).
8. **Chaînage d'intégrité** par société × journal : SHA-256 de la sérialisation canonique (JSON trié, montants en chaîne) de l'écriture validée, de ses lignes et de l'empreinte précédente ; tête de chaîne verrouillée dans la transaction de validation ; vérificateur rejouable. Le chaînage détecte une altération mais ne constitue pas seul une preuve d'inviolabilité : un ancrage externe sera spécifié ultérieurement.
9. **Accès** : garde Lot 0 (`requireAccountingAdmin`) sur chaque Server Action et route ; contexte société figé pour la durée de l'opération. SUPER_ADMIN refusé (décision D2) jusqu'à la spécification d'un contexte de supervision explicite et journalisé.
10. **Ordre des lots (D5)** : remise à niveau + garde multi-société → cet ADR + SPEC-ACC-A → **Lot B minimal** (protection des pièces de facturation) → **A1** (moteur sur données synthétiques) → raccordement des factures après revue des deux lots.

## Conséquences

- Aucune écriture comptable ne sera générée à partir des factures existantes avant la fin du Lot B minimal.
- Migrations SQL brutes nécessaires (déclencheurs, contraintes différées, FK composites) en plus du schéma Prisma.
- Tests PostgreSQL obligatoires (concurrence, rollback, isolation) en plus des tests unitaires.
- Le module ne prétend pas être une comptabilité française complète tant que FEC, TVA détaillée et facturation électronique ne sont pas livrés et validés.

## Alternatives considérées

- **Logiciel comptable externe via API/export** : moins de code, mais dépendance, double saisie et perte de lien natif avec chantiers/factures ; gardé comme option d'export (FEC) plutôt que source de vérité.
- **Decimal(14,2)** au lieu de centimes BigInt : exact aussi, mais plus de risques de conversions implicites côté TypeScript ; rejeté pour le moteur.
- **Comptabilité de trésorerie simple (recettes/dépenses)** : insuffisante pour TVA, bilan et FEC ; rejetée.

## SPEC / TASK d'implémentation

- `docs/specs/accounting/SPEC-ACC-A.md` (Proposé)
- Lot 0 : socle (flag, garde, navigation) — rebasé sur main, non poussé.
