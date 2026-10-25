/** Autorité commune V2 : identité et appartenance entreprise relues sous verrou. */
import type { Prisma } from "@prisma/client"
import { MileageDomainError } from "./mileage-domain"
import { assertMileageAccess, type MileageAction, type MileageActor, type requireMileageSession } from "./mileage-access"
type Session = ReturnType<typeof requireMileageSession>
type Employee = { id: string; userId: string; companyId: string; active: boolean; role: string }
type Team = { id: string; companyId: string; leaderId: string; active: boolean; name: string }
export async function authorizeVehicleLocked(tx: Prisma.TransactionClient, truckId: string, session: Session, action: MileageAction) {
  const locked = action === "READ"
    ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "trucks" WHERE "id" = ${truckId} AND "companyId" = ${session.companyId} FOR SHARE`
    : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "trucks" WHERE "id" = ${truckId} AND "companyId" = ${session.companyId} FOR UPDATE`
  if (!locked.length) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
  const truck = await tx.truck.findFirst({ where: { id: truckId, companyId: session.companyId } })
  if (!truck) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
  const users = await tx.$queryRaw<MileageActor[]>`
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
  // Mirrors resolveCompanyAccess without silently falling back to another company.
  // A present but inactive profile prevents the legacy primary-company fallback.
  const effectiveRole = identity.role === "SUPER_ADMIN" ? "SUPER_ADMIN"
    : employee ? employee.active ? employee.role : null
      : identity.companyId === session.companyId ? identity.role : null
  if (!effectiveRole || effectiveRole !== session.role) throw new MileageDomainError("FORBIDDEN", 403)
  const actor: MileageActor = { ...identity, role: effectiveRole, companyId: session.companyId }
  const teams = truck.teamId ? await tx.$queryRaw<Team[]>`
    SELECT "id", "companyId", "leaderId", "active", "name" FROM "teams"
    WHERE "id" = ${truck.teamId} AND "companyId" = ${session.companyId} FOR SHARE` : []
  const team = teams[0] ?? null
  assertMileageAccess(action, { companyId: session.companyId, sessionRole: session.role, actor, truck, employee, team })
  return { truck, actor, team }
}
