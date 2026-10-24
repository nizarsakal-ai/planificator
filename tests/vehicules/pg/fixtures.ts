import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import type { MileageSession } from "../../../src/lib/vehicules/mileage-access"
export async function fixture(db: PrismaClient) {
  const prefix = `v2-test-${randomUUID()}`
  const company = await db.company.create({ data: { name: prefix, slug: prefix } })
  const otherCompany = await db.company.create({ data: { name: `${prefix}-other`, slug: `${prefix}-other` } })
  const user = await db.user.create({ data: { email: `${prefix}@example.test`, password: "local-test-unused", role: "EMPLOYEE", companyId: company.id, name: "V2 Test Admin" } })
  await db.employee.create({ data: { userId: user.id, companyId: company.id, role: "ADMIN", firstName: "V2", lastName: "Admin" } })
  await db.employee.create({ data: { userId: user.id, companyId: otherCompany.id, role: "ADMIN", firstName: "V2", lastName: "Other admin" } })
  const global = await db.user.create({ data: { email: `${prefix}-super@example.test`, password: "local-test-unused", role: "SUPER_ADMIN", name: "V2 Global" } })
  const truck = await db.truck.create({ data: { companyId: company.id, matricule: prefix } })
  const otherTruck = await db.truck.create({ data: { companyId: otherCompany.id, matricule: `${prefix}-other` } })
  const session = (companyId = company.id, id = user.id, role = "ADMIN"): MileageSession => ({ user: { id, role, companyId } })
  return { company, otherCompany, user, global, truck, otherTruck, session, deps: (s = session()) => ({ db, auth: async () => s }) }
}
