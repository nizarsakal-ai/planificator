/**
 * LOT-1W-1a — Types partagés par les cœurs d'écriture (SPEC-PLAN-AGENT-GATEWAY-002 §5.1).
 *
 * `agent` n'est jamais renseigné dans ce sous-lot (UI uniquement) ; il le sera par la passerelle (1W-3).
 */

export type WriteActor = {
  companyId: string
  /** UI : session.user.id ; agent : émetteur du principal (ADR-PLAN-002 D-W3). */
  actorUserId: string
  /** Présent ⇒ écriture agent. Non renseigné en 1W-1a. */
  agent?: { principalId: string; mandateId: string }
}

export type CoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: CoreErrorCode; details?: Readonly<Record<string, unknown>> }

/**
 * Codes de la SPEC §5.1, plus `TRANSACTION_FAILED` (1W-1a) : la SPEC n'a pas de code pour une
 * transaction annulée alors que l'UI de BASE_SHA la traite distinctement (message générique +
 * `console.error`). Ajout signalé dans la fiche de livraison, à entériner ou renommer en revue.
 */
export type CoreErrorCode =
  | "VALIDATION"
  | "CLIENT_NOT_FOUND"
  | "WORKSITE_NOT_FOUND"
  | "TEAM_NOT_FOUND"
  | "DATA_ANOMALY"
  | "TEAM_CONFLICT"
  | "EMPLOYEE_CONFLICT"
  | "DUPLICATE_WORKSITE"
  | "TRANSACTION_FAILED"
