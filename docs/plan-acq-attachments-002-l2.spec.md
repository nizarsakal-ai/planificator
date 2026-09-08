# PLAN-ACQ-ATTACHMENTS-002-L2 — SPEC

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-ACQ-ATTACHMENTS-002-L2 |
| **Version** | 1.1.0 (L2-R1) |
| **Statut** | Implémentation locale — CORRECTION REVIEW READY |
| **ADR** | ADR-PLAN-002 (statut Proposé) |
| **Date** | 2026-09-08 |

## 1. Objectif

Renforcer localement le flux générique :

`DISCOVERED → claim → fetch Gmail (simulé) → validate → SHA-256 → storage privé (simulé)
→ STORED → bytes → PDF texte (unpdf) → excerpts → re-extraction séparée`

Sans Worksite, auto-approve, auto-convert, OCR, flags activés en prod, route HTTP, cron Vercel.

## 2. Règle octet-stream / image

Accepté **ssi** :

- `declaredMimeType === application/octet-stream` ;
- extension ∈ {`.jpg`, `.jpeg`, `.png`} ;
- magic JPEG/PNG concordant strictement avec l’extension ;
- pas de marqueur actif (HTML/SVG/script/MZ) ;
- taille ≤ `ACQUISITION_ATTACHMENT_MAX_BYTES` (appliquée au download).

MIME effectif persisté : `image/jpeg` ou `image/png`.

Rejets : mismatch extension/magic ; octet-stream sans extension image ; PPTX MIME inchangé (rejeté) ;
XLSX correct → téléchargeable, **pas** d’extrait texte L2.

## 3. Classification Gmail (download)

| Situation | Code Attachment | Retry auto |
|-----------|-----------------|------------|
| 404 / pièce absente | `GMAIL_ATTACHMENT_NOT_FOUND` | non |
| 401 / 403 / refresh token fail | `GMAIL_UNAUTHORIZED` | **non** |
| 429 | `GMAIL_RATE_LIMITED` | oui (borné) |
| 5xx / timeout / réseau | `GMAIL_UNAVAILABLE` | oui (borné) |
| Payload / decode | `ATTACHMENT_DECODE_FAILED` | non |
| Connexion absente | `GMAIL_NOT_CONNECTED` | oui (borné) |
| Code Gmail inconnu retryable | `GMAIL_UNAVAILABLE` | oui (borné) |
| Code Gmail inconnu non retryable | `GMAIL_PROVIDER_FAILED` | **non** (jamais faux NOT_FOUND) |

Contrat GmailProviderError **HEAD uniquement** (`code`, `retryable`, …) —
**aucune** dépendance à `httpStatus` (overlay DIAG).

Allowlist retry : `GMAIL_NOT_CONNECTED`, `ATTACHMENT_STORAGE_FAILED`,
`GMAIL_RATE_LIMITED`, `GMAIL_UNAVAILABLE`.

## 4. Machine d’états (inchangée)

`DISCOVERED` → `PENDING_DOWNLOAD` → `STORED` | `REJECTED` | `FAILED`
Recovery : reclaim TTL `PENDING_DOWNLOAD` ; retry `FAILED` allowlist → `DISCOVERED`.

Download **ne** déclenche **pas** extraction / auto / Worksite.

## 5. PDF texte

Réutilise `extractPdfTextLayer` / `buildAttachmentTextExcerpts`.
`PLAN` + (`PDF_NO_TEXT_LAYER` \| `PDF_PARSE_FAILED`) → `REQUIRED_DOCUMENT_UNREADABLE` (blocking).
Une autre PJ lisible ne retire pas ce warning.

## 6. Mailboxes

Runtime : `companyId` + `sourceMailboxKey` → `connectionId`.
Autorisées ops : `nohisac3@gmail.com`, `galyaevents1@gmail.com`.
Exclue : `nselelec@gmail.com` — **config DB `active`**, pas de hardcode L2.

## 7. Tests

- `tests/acquisition/attachment-policy.test.ts` (octet-stream L2)
- `tests/acquisition/gmail-attachment-error-map.test.ts`
- `tests/acquisition/attachment-download.service.test.ts`
- `tests/acquisition/attachment-retry.policy.test.ts`
- `tests/acquisition/attachments-002-l2.test.ts` (flux intégré fake)
- `tests/acquisition/attachments-002-l2-orchestrator.test.ts` (ordre + gates)
- L1 / L1-R1 extraction (non régression)

## 8. Hors périmètre / reliquat

- OCR ; PPTX/XLSX texte ; route admin ; cron Vercel ; activation flags.
- **Reprise post-reconnexion OAuth** (runbook) :
  1. Diagnostiquer `lastErrorCode=GMAIL_UNAUTHORIZED` (jamais confondre avec NOT_FOUND).
  2. Reconnecter la boîte via le flux OAuth Acquisition existant (UI/admin déjà en place).
  3. Reprise contrôlée **uniquement** via un mécanisme applicatif/repository autorisé
     (re-queue / reclaim métier) — **pas** de SQL manuel comme procédure normale.
  4. L’outil de reprise automatisée post-OAuth reste un **lot futur** ; R1/L2 ne l’ajoutent pas.
  5. Tant que la pièce est `FAILED` + `GMAIL_UNAUTHORIZED`, elle n’entre pas dans le retry auto
     (évite la boucle) et n’est **pas** marquée `GMAIL_ATTACHMENT_NOT_FOUND`.

## 9. Staging futur (fichiers envisagés)

- Script/route admin gardée (hors L2) appelant `downloadAcquisitionAttachment({companyId, attachmentId})`
- Puis `runDraftExtraction` séparé, `AUTO_*` OFF
- Contrôles DB avant/après sans exposer URL / externalAttachmentId
