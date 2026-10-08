import { MileageDomainError } from "./mileage-domain"

export type MileageAction = "READ" | "READING" | "START" | "END" | "CORRECTION"

export interface MileageSession {
  user?: { id?: string | null; role?: string | null; companyId?: string | null } | null
}

export interface MileageActor {
  id: string
  role: string
  companyId: string | null
  active: boolean
  name: string | null
}

export interface MileageAccessContext {
  companyId: string
  sessionRole: string
  actor: MileageActor
  truck: { companyId: string; teamId: string | null }
  employee: { id: string; userId: string; companyId: string; active: boolean } | null
  team: { id: string; companyId: string; leaderId: string; active: boolean } | null
}

/** Session serveur uniquement. Aucun companyId du payload n'est accepté. */
export function requireMileageSession(session: MileageSession | null) {
  const user = session?.user
  if (!user?.id) throw new MileageDomainError("UNAUTHENTICATED", 401)
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(user.role ?? ""))
    throw new MileageDomainError("FORBIDDEN", 403)
  const companyId = user.companyId?.trim()
  if (!companyId) throw new MileageDomainError("NO_COMPANY", 403)
  return { userId: user.id, role: user.role!, companyId }
}

/** Pure, appelée après relecture/verrouillage des données d'autorité. */
export function assertMileageAccess(action: MileageAction, context: MileageAccessContext): void {
  const { companyId, sessionRole, actor, truck, employee, team } = context
  if (!actor.active) throw new MileageDomainError("UNAUTHENTICATED", 401)
  if (actor.role !== sessionRole) throw new MileageDomainError("FORBIDDEN", 403)
  // Le contexte d'un SUPER_ADMIN global doit déjà exister dans la session serveur.
  // Ce cas ne choisit jamais une société à partir du véhicule ou du payload.
  if (actor.companyId !== companyId && !(actor.role === "SUPER_ADMIN" && actor.companyId === null))
    throw new MileageDomainError("FORBIDDEN", 403)
  if (truck.companyId !== companyId) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
  if (actor.role === "ADMIN" || actor.role === "SUPER_ADMIN") return
  if (actor.role !== "TEAM_LEADER" || !["READ", "START", "END"].includes(action))
    throw new MileageDomainError("FORBIDDEN", 403)
  if (!employee?.active || employee.userId !== actor.id || employee.companyId !== companyId)
    throw new MileageDomainError("FORBIDDEN", 403)
  if (!team?.active || team.id !== truck.teamId || team.companyId !== companyId || team.leaderId !== employee.id)
    throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
}
