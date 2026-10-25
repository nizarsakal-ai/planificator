/**
 * Véhicules V3 — journal d'audit en ajout seul (table vehicle_audit_logs, trigger SQL).
 * Accès documentaires et commandes sensibles. Jamais d'URL signée ni de secret dans `detail`.
 */
import type { Prisma } from "@prisma/client"

export type VehicleAuditOutcome = "GRANTED" | "DENIED" | "DONE" | "FAILED"

export interface VehicleAuditEntry {
  companyId: string
  truckId: string | null
  actorId: string
  actorNameSnapshot: string
  action: string
  entityType: string
  entityId: string | null
  outcome: VehicleAuditOutcome
  detail?: Record<string, string | number | boolean | null>
}

const FORBIDDEN_DETAIL = /https?:\/\/|signature|api_secret|token=/i

export async function writeVehicleAudit(tx: Pick<Prisma.TransactionClient, "vehicleAuditLog">, entry: VehicleAuditEntry): Promise<void> {
  const detail = entry.detail
    ? Object.fromEntries(Object.entries(entry.detail).filter(([, value]) => !(typeof value === "string" && FORBIDDEN_DETAIL.test(value))))
    : undefined
  await tx.vehicleAuditLog.create({ data: {
    companyId: entry.companyId, truckId: entry.truckId, actorId: entry.actorId,
    actorNameSnapshot: entry.actorNameSnapshot.trim() || entry.actorId,
    action: entry.action, entityType: entry.entityType, entityId: entry.entityId, outcome: entry.outcome,
    detail: detail === undefined ? undefined : detail,
  } })
}
