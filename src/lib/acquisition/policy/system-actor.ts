/**
 * PLAN-ACQ-V2 Lot F R2 — Validation acteur SYSTEM (tenant + rôle).
 */

import type { PrismaClient, Role } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { getAcquisitionSystemActorUserId } from "@/lib/acquisition/policy/auto-decision-feature-flag"

const ALLOWED_SYSTEM_ROLES = new Set<Role>(["ADMIN", "SUPER_ADMIN"])

export type SystemActorResolution =
  | { ok: true; userId: string; role: Role }
  | { ok: false; code: "SYSTEM_ACTOR_MISSING" | "SYSTEM_ACTOR_INVALID"; reason: string }

/**
 * Résout et valide ACQUISITION_SYSTEM_ACTOR_USER_ID pour un tenant.
 * Aucun secret journalisé — codes stables uniquement.
 */
export async function resolveValidatedSystemActor(
  companyId: string,
  db: PrismaClient = prisma
): Promise<SystemActorResolution> {
  const userId = getAcquisitionSystemActorUserId()
  if (!userId) {
    return { ok: false, code: "SYSTEM_ACTOR_MISSING", reason: "env_unset" }
  }
  if (!companyId) {
    return { ok: false, code: "SYSTEM_ACTOR_INVALID", reason: "company_missing" }
  }

  const user = await db.user.findFirst({
    where: { id: userId },
    select: { id: true, companyId: true, role: true, active: true },
  })

  if (!user) {
    return { ok: false, code: "SYSTEM_ACTOR_INVALID", reason: "user_not_found" }
  }
  if (user.companyId !== companyId) {
    return { ok: false, code: "SYSTEM_ACTOR_INVALID", reason: "tenant_mismatch" }
  }
  // User.active existe dans schema.prisma (Boolean @default(true))
  if (user.active !== true) {
    return { ok: false, code: "SYSTEM_ACTOR_INVALID", reason: "user_inactive" }
  }
  if (!ALLOWED_SYSTEM_ROLES.has(user.role)) {
    return { ok: false, code: "SYSTEM_ACTOR_INVALID", reason: "role_forbidden" }
  }

  return { ok: true, userId: user.id, role: user.role }
}
