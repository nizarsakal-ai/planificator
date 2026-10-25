/**
 * Véhicules V3 — matrice de droits explicite, appliquée au-dessus de l'autorité V2.
 *
 * L'appartenance effective à l'entreprise, le rôle effectif et le verrou du camion sont
 * relus sous transaction par `authorizeVehicleLocked` (vehicle-authority, inchangé).
 * V3 ne fait que traduire ses actions vers une action V2 équivalente :
 *   - lectures autorisées au chef d'équipe affecté → "READ" (verrou partagé) ;
 *   - commandes réservées aux administrateurs → "READING" (verrou exclusif, chef refusé).
 * Aucun droit implicite n'est accordé au chauffeur, à l'employé ou au client :
 * `requireMileageSession` refuse déjà ces rôles avant toute requête.
 */
import type { Prisma } from "@prisma/client"
import type { VehicleDocumentCategory } from "@prisma/client"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { MileageDomainError } from "../mileage-domain"
import type { MileageAction, requireMileageSession } from "../mileage-access"

type Session = ReturnType<typeof requireMileageSession>

export type VehicleV3Action =
  | "DOCUMENT_LIST"
  | "DOCUMENT_READ_FILE"
  | "DOCUMENT_WRITE"
  | "DOCUMENT_VERIFY"
  | "DOCUMENT_ARCHIVE"
  | "REMINDER_SETTINGS_WRITE"

/** Rubriques consultables par un chef d'équipe affecté ; la carte grise reste réservée. */
export const TEAM_LEADER_DOCUMENT_CATEGORIES: readonly VehicleDocumentCategory[] = [
  "TECHNICAL_INSPECTION", "REPAIR_MAINTENANCE", "INSURANCE",
]

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])

/** Action V2 équivalente : définit le verrou et le périmètre de rôle relu sous transaction. */
export function lockActionFor(action: VehicleV3Action): MileageAction {
  switch (action) {
    case "DOCUMENT_LIST":
    case "DOCUMENT_READ_FILE":
      return "READ"
    default:
      return "READING"
  }
}

/** Rubriques visibles pour un rôle effectif ; vide = aucune. */
export function visibleDocumentCategories(effectiveRole: string): readonly VehicleDocumentCategory[] {
  if (ADMIN_ROLES.has(effectiveRole)) return ["TECHNICAL_INSPECTION", "REPAIR_MAINTENANCE", "REGISTRATION", "INSURANCE", "EXPENSE_RECEIPT"]
  if (effectiveRole === "TEAM_LEADER") return TEAM_LEADER_DOCUMENT_CATEGORIES
  return []
}

export function canReadDocumentCategory(effectiveRole: string, category: VehicleDocumentCategory): boolean {
  return visibleDocumentCategories(effectiveRole).includes(category)
}

type Employee = { id: string; userId: string; companyId: string; active: boolean; role: string }

/**
 * Autorité d'entreprise sans camion (paramètres de rappel) : mêmes relectures sous verrou
 * partagé que vehicle-authority (identité, entreprise active, appartenance effective),
 * réservée aux administrateurs de l'entreprise explicite de la session.
 */
export async function authorizeCompanyAdminLocked(tx: Prisma.TransactionClient, session: Session) {
  const users = await tx.$queryRaw<{ id: string; role: string; companyId: string | null; active: boolean; name: string | null }[]>`
    SELECT "id", "role"::text AS "role", "companyId", "active", "name" FROM "users"
    WHERE "id" = ${session.userId} FOR SHARE`
  const identity = users[0]
  if (!identity?.active) throw new MileageDomainError("UNAUTHENTICATED", 401)
  const companies = await tx.$queryRaw<{ id: string; active: boolean }[]>`
    SELECT "id", "active" FROM "companies" WHERE "id" = ${session.companyId} FOR SHARE`
  if (!companies[0]?.active) throw new MileageDomainError("FORBIDDEN", 403)
  const employees = await tx.$queryRaw<Employee[]>`
    SELECT "id", "userId", "companyId", "active", "role"::text AS "role" FROM "employees"
    WHERE "userId" = ${identity.id} AND "companyId" = ${session.companyId} FOR SHARE`
  const employee = employees[0] ?? null
  const effectiveRole = identity.role === "SUPER_ADMIN" ? "SUPER_ADMIN"
    : employee ? employee.active ? employee.role : null
      : identity.companyId === session.companyId ? identity.role : null
  if (!effectiveRole || effectiveRole !== session.role || !ADMIN_ROLES.has(effectiveRole)) throw new MileageDomainError("FORBIDDEN", 403)
  return { actor: { id: identity.id, name: identity.name, role: effectiveRole, companyId: session.companyId } }
}

/**
 * Autorise une action V3 sur un camion, sous le verrou et l'autorité V2.
 * Retourne le camion, l'acteur effectif et l'équipe comme vehicle-authority.
 */
export async function authorizeVehicleV3(
  tx: Prisma.TransactionClient,
  truckId: string,
  session: Session,
  action: VehicleV3Action,
) {
  const authorized = await authorizeVehicleLocked(tx, truckId, session, lockActionFor(action))
  const role = authorized.actor.role
  if (!ADMIN_ROLES.has(role) && role !== "TEAM_LEADER") throw new MileageDomainError("FORBIDDEN", 403)
  if (!ADMIN_ROLES.has(role) && lockActionFor(action) !== "READ") throw new MileageDomainError("FORBIDDEN", 403)
  return { ...authorized, categories: visibleDocumentCategories(role) }
}
