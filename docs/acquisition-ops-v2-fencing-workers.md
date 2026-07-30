# PLAN-ACQ-V2 — Fencing mid-worker hors Gmail (R3)

Document technique — **pas** une activation. Aucun secret.

## État actuel

| Étape orchestrateur | Renouvellement périodique (`renew` / `shouldContinue`) | Fence avant / après |
|---------------------|--------------------------------------------------------|---------------------|
| `gmailSync` | **Oui** — deadline clampée + `shouldContinue` + `renew` pendant le scan | `assertOwned` final avant SUCCESS |
| `attachmentRecovery` | Non | Budget enfant clampé ; `assertOwned` entre étapes au niveau orchestrateur |
| `attachmentDownload` | Non | idem |
| `contentFetch` | Non | idem |
| `extraction` | Non | idem |

Source : `src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts`,
`acquisition-orchestrator.service.ts` (boucle `STEP_ORDER` : `assertOwned` avant chaque step).

## Pourquoi le risque est atténué aujourd’hui

1. **Invariant TTL ≥ maxDuration** du run orchestrateur : une exécution ne devrait pas survivre au lease tant que la durée max + marge de sécurité reste inférieure au TTL.
2. **Fence inter-étapes** : avant chaque step, `assertOwned` refuse de démarrer si le lease a été repris (`LEASE_STOLEN`).
3. **Budget enfant clampé** : chaque worker reçoit `maxDurationMs = min(remainingMs, config)` — pas de budget « infini » si le parent a presque épuisé son temps.
4. Le worker Gmail (souvent le plus long) a déjà le heartbeat mid-run.

## Risque résiduel

Si une étape non-Gmail (ex. extraction Anthropic, download pièces) **dépasse le TTL du lease** pendant qu’elle tourne, une autre exécution peut acquérir le lease pendant que l’ancienne continue d’écrire — **sans** heartbeat mid-run sur ces workers.

## Lot technique à prévoir (avant traitements longs en production)

**Ticket proposé :** `PLAN-ACQ-V2-FENCING-WORKERS`
Étendre le pattern Gmail (`shouldContinue` + `renew` atomique + fence final) aux runners :

- attachment recovery / download
- content fetch
- extraction

Critères d’acceptation suggérés :

- heartbeat périodique borné (pas de spam)
- perte de lease → arrêt sans finalisation SUCCESS
- tests expiration mid-run + concurrence (comme Gmail R2)

**GO traitements longs prod** : uniquement après ce lot, ou si chaque worker individuel a une `maxDurationMs` strictement inférieure au TTL avec marge prouvée.
