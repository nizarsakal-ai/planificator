# ADR-PLAN-002 — Téléchargement sécurisé PJ + PDF texte (L2)

| Champ | Valeur |
|-------|--------|
| **Identifiant** | ADR-PLAN-002 |
| **Statut** | Proposé |
| **Date** | 2026-09-08 |
| **Module** | Acquisition / Attachments |
| **SPEC** | PLAN-ACQ-ATTACHMENTS-002-L2 |

## Contexte

Les pièces jointes restent souvent en `DISCOVERED` (flags fail-closed). L’extraction
peut atteindre `PENDING_REVIEW` sur le corps tout en émettant `REQUIRED_DOCUMENT_UNREADABLE`
si un PDF `PLAN` n’a pas de bytes STORED ou pas de couche texte. Gmail déclare parfois
des JPEG/PNG en `application/octet-stream`, ce qui les faisait rejeter. Les erreurs
Gmail 401/403 étaient trop souvent réduites à `GMAIL_ATTACHMENT_NOT_FOUND`.

## Décision

1. **Réutiliser** les ports existants (`GmailAttachmentSource`, `AttachmentStorage`,
   repository, download service, bytes loader, `unpdf`, extraction provider) —
   aucun nouveau framework agent, aucune route HTTP admin, aucun couplage download → Worksite.
2. **Accepter** `application/octet-stream` pour `.jpg`/`.jpeg`/`.png` **uniquement** si
   magic bytes concordent ; MIME effectif normalisé (`image/jpeg` | `image/png`).
3. **Classifier** les erreurs Gmail via taxonomie HEAD (`GmailProviderError.code` /
   `retryable`) — **sans** `httpStatus` DIAG :
   404 → `GMAIL_ATTACHMENT_NOT_FOUND` ; 401/403 → `GMAIL_UNAUTHORIZED` (non retry auto) ;
   429 → `GMAIL_RATE_LIMITED` ; 5xx/réseau → `GMAIL_UNAVAILABLE` (retry borné) ;
   code inconnu non retryable → `GMAIL_PROVIDER_FAILED` (jamais faux NOT_FOUND).
4. **Conserver** la machine d’états DISCOVERED → PENDING_DOWNLOAD → STORED | REJECTED | FAILED
   et le découplage download / extraction.
5. **Pas d’OCR** ni parsing PPTX/XLSX texte dans L2.

## Conséquences

- Les images mal typées Gmail deviennent stockables.
- Auth révoquée n’entre plus en boucle NOT_FOUND / retry confus.
- Reprise post-reconnexion OAuth : **reliquat** (pas de migration / callback OAuth L2) —
  ops doit reconnecter puis reclaim/re-DISCOVERED contrôlé.
- Boîtes Acquisition (`nohisac3`, `galyaevents1`) / exclusion `nselelec` :
  **invariant ops DB** (`active`), pas de hardcode runtime.

## Alternatives considérées

| Option | Motif de non-retenue |
|--------|----------------------|
| OCR immédiat | Hors périmètre ; coût ; pas de runtime |
| Route admin download ciblé | Hors L2 ; surface sécu |
| Hardcode adresses Gmail | Interdit ; multi-tenant générique |
| Retry auto 401/403 | Boucle dangereuse sur auth révoquée |

## Références

- SPEC : `docs/plan-acq-attachments-002-l2.spec.md`
- SECURITY : `docs/plan-acq-attachments-002-l2-security.spec.md`
- Audit : PLAN-ACQ-ATTACHMENTS-002-AUDIT-001
