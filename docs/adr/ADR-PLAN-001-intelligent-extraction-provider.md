# ADR-PLAN-001 — Extraction intelligente Acquisition (provider Anthropic)

| Champ | Valeur |
|-------|--------|
| **Identifiant** | ADR-PLAN-001 |
| **Statut** | Proposé |
| **Date** | 2026-09-08 |
| **Module** | Acquisition / Extraction |
| **SPEC** | PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1 |

## Contexte

Le provider déterministe (`rules-v1`) ne produit souvent qu’un signal date (semaine / plage),
ce qui fait échouer la gate métier (`CONTENT_INSUFFICIENT`) alors que le corps du message
contient nom de chantier, adresse et description. Le contrat Anthropic 005B-3 existe déjà
(adapter, schema tool, prompt) mais n’est pas activé en Production (`ACQUISITION_EXTRACTION_PROVIDER`
absent → défaut `deterministic`).

## Décision

1. **Réutiliser** l’abstraction `ExtractionProviderPort` / `AnthropicExtractionAdapter` existante ;
   ne pas créer de second moteur ni de logique métier codée pour un partenaire nommé.
2. **Sélection provider** : globale via `ACQUISITION_EXTRACTION_PROVIDER` (pas tenant-scoped dans ce lot).
3. **Lot L1** : corriger le drift `extractedData.schemaVersion` → `EXTRACTION_SCHEMA_VERSION` (`3`),
   renforcer le prompt générique (GPS → description/constraints ; distinction contractuel / site),
   ajouter tests mock sans appel live.
4. **Activation Production** : hors périmètre L1 (documentée, non appliquée).

## Conséquences

- Les tests L1 prouvent qu’un corps riche + mock Anthropic → `PENDING_REVIEW` même si PJ `DISCOVERED`.
- Les tests L1-R1 prouvent la chaîne **adapter public** (client mock) → **tool schema réel** →
  `mapAnthropicRawToProviderResult` → normalize → gate → `proposed*`.
- `REQUIRED_DOCUMENT_UNREADABLE` reste un warning blocking conversion/auto **et** approve manuelle,
  **pas** un ERROR de gate extraction.
- La résolution du client contractuel partenaire (registry) reste un mécanisme séparé ;
  l’IA ne doit pas inventer le Client Planificator.

## Compatibilité des versions d’extraction

| Canal | Rôle | Autorité |
|-------|------|----------|
| `WorksiteImportDraft.extractionSchemaVersion` | Version d’exécution figée au persist | **Fait autorité** pour ALREADY_EXTRACTED / identité journal |
| `extractedData.schemaVersion` | Version du payload JSON | Alignée sur `EXTRACTION_SCHEMA_VERSION` à l’écriture (L1) |

Comportement :

- **Nouvelles écritures** : colonne et JSON = `EXTRACTION_SCHEMA_VERSION` (`3`).
- **Anciens payloads JSON `schemaVersion: "2"`** : restent **lisibles** (clés métier inchangées) ;
  aucun consommateur runtime ne sélectionne sur `extractedData.schemaVersion`.
- **Drafts avec colonne `"2"`** : ne matchent pas `ALREADY_EXTRACTED` (compare à `"3"`) ;
  retraitement possible via `force` / policy re-extract (`PENDING_REVIEW`) ou statuts FAILED /
  PENDING_EXTRACTION selon politique existante ; une nouvelle extraction réécrit colonne+JSON en `"3"`.
- **Workers runtime** : comparent l’identité journal à `d.extractionSchemaVersion` du draft
  (`IS NOT DISTINCT FROM`) — **pas** de filtre littéral `=== "2"`.
  Les occurrences de `"2"` restantes sont surtout des **fixtures / dettes de tests**.

## Retour arrière

1. Désactiver le provider intelligent : retirer ou ne pas poser
   `ACQUISITION_EXTRACTION_PROVIDER=anthropic` (retour défaut `deterministic`) —
   **aucune migration DB**, **aucune suppression** des `extractedData` historiques.
2. Les drafts déjà en `"3"` restent valides ; `ALREADY_EXTRACTED` continue de fonctionner
   tant que `EXTRACTION_SCHEMA_VERSION` code reste `"3"`.
3. Si le code revenait temporairement à une constante `"2"` : les drafts colonne `"3"`
   ne seraient plus considérés ALREADY_EXTRACTED (ré-extract possible) — limite connue ;
   ne pas abaisser la constante sans plan de reprise.
4. Rollback config ≠ rollback des champs `proposed*` déjà persistés.

## Alternatives considérées

| Option | Motif de non-retenue |
|--------|----------------------|
| Enrichir uniquement le provider déterministe | Couverture trop faible pour consultations narratives |
| Nouveau provider ad hoc « Leroy » | Interdit (spécificité production) |
| Activer Anthropic en prod dans L1 | Hors périmètre (config / secrets / contrôle) |

## Références

- PLAN-ACQ-005B (autorité `runDraftExtraction`)
- `docs/plan-acq-intelligent-extraction-001-l1.spec.md`
- Tests : `intelligent-extraction-l1.test.ts`, `intelligent-extraction-l1-r1.test.ts`
- Aucune TASK d’activation Production à ce jour
