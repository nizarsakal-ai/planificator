# PLAN-ACQ-ATTACHMENTS-002-L2 — SECURITY SPEC

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-ACQ-ATTACHMENTS-002-L2-SECURITY |
| **Version** | 1.0.0 |
| **Statut** | Proposé (lot local) |
| **ADR** | ADR-PLAN-002 |
| **Date** | 2026-09-08 |
| **Secrets réels** | Aucun lu ni documenté |

## 1. Actifs

Binaires PJ · SHA-256 · `storagePublicId` · URLs signées Cloudinary · tokens Gmail
· `externalAttachmentId` · métadonnées filename/MIME · extraits PDF texte.

## 2. Contrôles L2

1. **Multi-tenant** : claim / markStored / find filtrés `companyId` (+ FK message).
2. **Validation** : MIME déclaré + extension + magic ; pas de confiance unique.
3. **Stockage** : authenticated/raw ; path `planificator/{companyId}/acquisition/{messageId}/{attachmentId}/…`.
4. **Logs** : interdiction storageUrl, token, externalAttachmentId complet, contenu binaire ;
   `sha256Prefix` 8 chars max dans download logs.
5. **Compensation** : destroy si upload OK et persist KO.
6. **Auth Gmail** : 401/403 → `GMAIL_UNAUTHORIZED` terminal auto-retry (pas de boucle) ;
   code Gmail inconnu non retryable → `GMAIL_PROVIDER_FAILED` (jamais faux NOT_FOUND) ;
   classification via contrat HEAD uniquement (pas de champ DIAG hors contrat).
7. **Retry** : allowlist exclusive + backoff borné (jitter).
8. **Fail-closed flags** : download OFF par défaut.
9. **Pas de hardcode** d’adresses mailbox dans le service générique.
10. **Extraction** découplée : pas de side-effect Worksite depuis download.

## 3. Menaces mitigées / résiduelles

| Menace | Mitigation L2 | Résidu |
|--------|---------------|--------|
| Upload malware HTML/SVG | magic + extensions bloquées | polyglots avancés |
| Cross-tenant | companyId partout | mauvaise connectionId ops |
| Boucle 401 | non retry `GMAIL_UNAUTHORIZED` | reprise manuelle post-OAuth |
| Fuite URL | logs redacted ; access signé séparé | mauvais logging futur |
| Zip bomb | taille max + pas d’extract archive L2 | zip nested hors scope |

## 4. Invariants ops (hors code)

- Connexions Acquisition actives = boîtes autorisées uniquement.
- `nselelec@gmail.com` non `active` sur le pipeline Acquisition.
- Staging : tester une PJ via service unitaire, jamais cron global multi-tenant chargé.
