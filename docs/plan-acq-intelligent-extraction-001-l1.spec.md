# PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1 — SPEC

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-ACQ-INTELLIGENT-EXTRACTION-001-L1 |
| **Version** | 1.1.0 (L1-R1) |
| **Statut** | Implémentation locale — CORRECTION REVIEW READY |
| **ADR** | ADR-PLAN-001 (statut Proposé) |
| **Date** | 2026-09-08 |

## 1. Objectif du lot

Permettre une extraction intelligente du **corps** de consultation via le provider Anthropic
existant (mock en tests), sans création de chantier, sans conversion, sans activation prod.

## 2. Contrat d’extraction (rappel)

| Champ canonique | `proposed*` / stockage | Règle |
|-----------------|------------------------|-------|
| `worksiteName` | `proposedWorksiteName` | Site / affaire / enseigne chantier |
| `clientName` | `proposedClientName` | Donneur d’ordre **seulement s’il est explicite** ; jamais inventé |
| `endClientName` | `extractedData.endClientName` | Client final / enseigne distincte |
| `address` / `postalCode` / `city` | `proposedAddress` / CP / ville | Faits du corps |
| `requestedStartDate` / `End` | `proposedStartDate` / `End` | Période prestation |
| `description` | `proposedDescription` | Périmètre + GPS si présents |
| `clientConsultationDate` | colonne dédiée | Jamais = `receivedAt` |

Client Planificator contractuel via **registry partenaire** : hors IA si non présent dans le corps.

`schemaVersion` payload = `EXTRACTION_SCHEMA_VERSION` (`3`).

## 3. Sélection provider

- Env globale : `ACQUISITION_EXTRACTION_PROVIDER=anthropic` (+ modèle / clé).
- Aucun fallback silencieux vers deterministic.
- L1 **n’active pas** cette config en Production.

## 4. Gate & PJ

- Signal fort requis (nom / client / adresse / réf) — dates seules → `CONTENT_INSUFFICIENT`.
- `REQUIRED_DOCUMENT_UNREADABLE` : `blocking: true`, `severity: WARNING` → **ne force pas** `FAILED`
  si signal fort présent ; impact auto-convert / human review.
- Téléchargement PJ : **lot suivant** (hors L1).

## 5. Plan de tests

Fichiers :
- `tests/acquisition/intelligent-extraction-l1.test.ts`
- `tests/acquisition/intelligent-extraction-l1-r1.test.ts` (contrat adapter + compat v2/v3)

Couverture L1 :
- extraction complète fixture assainie (mock port) ;
- distinction contractuel / final / chantier ;
- adresse, CP, ville, dates, description + GPS ;
- absence d’hallucination (contact / réf / clientConsultationDate) ;
- provider indisponible / invalide ;
- contenu insuffisant (dates seules) ;
- dates contradictoires ;
- isolation tenant ;
- PJ `DISCOVERED` + parse PDF fail → toujours `PENDING_REVIEW` si corps riche ;
- `schemaVersion === "3"` ;
- compteurs `worksiteCreates` / conversion = 0.

Couverture L1-R1 :
- `AnthropicExtractionAdapter` + client mock ; assert `tools[0].input_schema === EXTRACTION_TOOL_DEFINITION.input_schema` ;
- chaîne tool_use → `mapAnthropicRawToProviderResult` → normalize → gate → persist `proposed*` ;
- `endClientName` dans `extractedData` ; GPS dans description ;
- réponse brute hors schéma → `PROVIDER_INVALID_OUTPUT` sans persist partiel dangereux ;
- payload JSON historique `"2"` lisible ; nouvelles écritures `"3"` ;
- `ALREADY_EXTRACTED` (colonne v3, même hash) sans boucle ;
- colonne historique `"2"` + `force` → retraitement → persist v3 ;
- scan runtime : aucun `extractionSchemaVersion === "2"` dans orchestrator/extraction/policy.

## 5bis. Compatibilité colonne / JSON

| Élément | Rôle |
|---------|------|
| Colonne `extractionSchemaVersion` | Autorité runtime (ALREADY_EXTRACTED, identité journal workers) |
| `extractedData.schemaVersion` | Version payload ; alignée à l’écriture sur `EXTRACTION_SCHEMA_VERSION` |

- Anciens JSON `"2"` : lisibles ; non utilisés comme filtre de sélection.
- Nouvelles écritures : colonne + JSON = `"3"`.
- Workers : pas de filtre littéral `"2"` (dettes surtout dans fixtures de tests).
- Retraitement : mismatch colonne vs constante courante empêche ALREADY_EXTRACTED ;
  policy `force` / FAILED / PENDING_EXTRACTION selon statut.

## 5ter. Retour arrière (config)

- Retirer `ACQUISITION_EXTRACTION_PROVIDER=anthropic` → défaut deterministic.
- Ne pas supprimer les données historiques.
- Limite : ne pas rabaisser la constante code `"3"` → `"2"` sans plan (sinon perte ALREADY_EXTRACTED sur drafts v3).

## 6. Limites L1 / prochain lot

| Hors L1 | Lot recommandé |
|---------|----------------|
| Activation `ACQUISITION_EXTRACTION_PROVIDER=anthropic` Production | Lot activation contrôlée + smoke Staging |
| Download PJ + texte PDF STORED | PLAN-ACQ-ATTACHMENT-DOWNLOAD |
| Auto-approve / auto-convert | Flags AUTO + anti-doublon ; lever `REQUIRED_DOCUMENT_UNREADABLE` |
| Relance réelle draft prod | Après activation + download |

Note revue : `PENDING_REVIEW` + `REQUIRED_DOCUMENT_UNREADABLE` bloque aussi l’**approve manuelle**
(`hasBlockingWarnings`) — sécurité métier intentionnelle.

## 7. Activation (documentation seule — non appliquée)

```text
# Production — NE PAS APPLIQUER DANS L1 / L1-R1
ACQUISITION_EXTRACTION_PROVIDER=anthropic
# + ANTHROPIC_API_KEY / modèle déjà présents selon env ls
# Garder ACQUISITION_EXTRACTION_ENABLED=true
# Ne pas activer AUTO_* ni attachment download dans le même lot
```
