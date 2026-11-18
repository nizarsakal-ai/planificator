/**
 * Autorité « chauffeur » : le chauffeur attitré d'un camion (Truck.chauffeurId) peut y déposer un ticket
 * (justificatif EXPENSE_RECEIPT), le faire lire et enregistrer le plein correspondant. Rien d'autre :
 * ni lecture du dossier du camion, ni coûts, ni autre catégorie, ni autre camion.
 *
 * Tout est relu sous verrou à chaque transaction (utilisateur actif, entreprise active, profil employé
 * actif de l'entreprise, rôle de session identique au rôle effectif, camion actif dont il est le chauffeur).
 * L'autorité administrateur existante n'est pas modifiée.
 */
import type { Prisma } from "@prisma/client"
import { MileageDomainError } from "../mileage-domain"
import type { MileageActor } from "../mileage-access"

export interface DriverSession { userId: string; companyId: string; role: string }

export const DRIVER_RECEIPT_ROLES = new Set(["EMPLOYEE", "TEAM_LEADER", "ADMIN", "SUPER_ADMIN"])
export const DRIVER_RECEIPT_CATEGORY = "EXPENSE_RECEIPT" as const

type Employee = { id: string; userId: string; companyId: string; active: boolean; role: string }

/** Session applicative → session chauffeur (aucune autre donnée n'est retenue). */
export function driverSessionFrom(raw: { user?: { id?: string | null; role?: string | null; companyId?: string | null } | null } | null): DriverSession {
  const u = raw?.user
  if (!u?.id || !u.companyId || !u.role) throw new MileageDomainError("UNAUTHENTICATED", 401)
  if (!DRIVER_RECEIPT_ROLES.has(u.role)) throw new MileageDomainError("FORBIDDEN", 403)
  return { userId: u.id, companyId: u.companyId, role: u.role }
}

/** Identité relue sous verrou ; renvoie le profil employé actif de l'entreprise. */
async function lockedDriverIdentity(tx: Prisma.TransactionClient, session: DriverSession) {
  const users = await tx.$queryRaw<MileageActor[]>`
    SELECT "id", "role"::text AS "role", "companyId", "active", "name" FROM "users" WHERE "id" = ${session.userId} FOR SHARE`
  const identity = users[0]
  if (!identity?.active) throw new MileageDomainError("UNAUTHENTICATED", 401)
  const companies = await tx.$queryRaw<{ active: boolean }[]>`SELECT "active" FROM "companies" WHERE "id" = ${session.companyId} FOR SHARE`
  if (!companies[0]?.active) throw new MileageDomainError("FORBIDDEN", 403)
  const employees = await tx.$queryRaw<Employee[]>`
    SELECT "id", "userId", "companyId", "active", "role"::text AS "role" FROM "employees"
    WHERE "userId" = ${identity.id} AND "companyId" = ${session.companyId} FOR SHARE`
  const employee = employees[0]
  // Un chauffeur est toujours un profil employé actif de l'entreprise (pas de repli « entreprise principale »).
  if (!employee?.active) throw new MileageDomainError("FORBIDDEN", 403)
  const effectiveRole = identity.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : employee.role
  if (effectiveRole !== session.role || !DRIVER_RECEIPT_ROLES.has(effectiveRole)) throw new MileageDomainError("FORBIDDEN", 403)
  const actor: MileageActor = { ...identity, role: effectiveRole, companyId: session.companyId }
  return { actor, employee }
}

/** Camions dont l'utilisateur est le chauffeur attitré (lecture, sans verrou d'écriture). */
export async function findDriverTrucks(tx: Prisma.TransactionClient, session: DriverSession) {
  const { employee } = await lockedDriverIdentity(tx, session)
  return tx.truck.findMany({
    where: { companyId: session.companyId, chauffeurId: employee.id, active: true, archivedAt: null },
    select: { id: true, matricule: true, marque: true, modele: true },
    orderBy: { matricule: "asc" },
  })
}

/**
 * Autorise l'écriture d'un ticket sur `truckId`. Même forme de retour que l'autorité V3
 * ({ truck, actor, team, categories }) pour être injectée dans les services existants.
 */
export async function authorizeDriverReceipt(tx: Prisma.TransactionClient, truckId: string, session: DriverSession) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "trucks" WHERE "id" = ${truckId} AND "companyId" = ${session.companyId} FOR UPDATE`
  if (!locked.length) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
  const truck = await tx.truck.findFirst({ where: { id: truckId, companyId: session.companyId } })
  if (!truck) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
  const { actor, employee } = await lockedDriverIdentity(tx, session)
  // Non chauffeur de ce camion : même réponse qu'un camion inexistant (aucune énumération).
  if (truck.chauffeurId !== employee.id) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
  return { truck, actor, team: null, categories: [DRIVER_RECEIPT_CATEGORY] as const }
}
