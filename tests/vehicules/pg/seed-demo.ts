import { hash } from "bcryptjs"
import { localDb } from "./local-db"
import { executeMileageCommand } from "../../../src/lib/vehicules/mileage-service"
import { recordMaintenance, updateMaintenancePlan } from "../../../src/lib/vehicules/maintenance-service"
import { randomUUID } from "node:crypto"
async function main() {
const db = localDb()
try {
  const company = await db.company.upsert({ where: { slug: "v2-test-browser-demo" }, update: {}, create: { slug: "v2-test-browser-demo", name: "Démonstration Véhicule V2" } })
  const user = await db.user.upsert({ where: { email: "vehicule-v2@example.test" }, update: { active: true, password: await hash("Test-Vehicule-V2-2026", 10) }, create: { email: "vehicule-v2@example.test", password: await hash("Test-Vehicule-V2-2026", 10), name: "Super Admin V2 local", role: "SUPER_ADMIN", companyId: company.id } })
  await db.employee.upsert({ where: { userId_companyId: { userId: user.id, companyId: company.id } }, update: {}, create: { userId: user.id, companyId: company.id, firstName: "Super", lastName: "Admin V2", role: "ADMIN" } })
  const deps = { db, auth: async () => ({ user: { id: user.id, companyId: company.id, role: "SUPER_ADMIN" } }) }
  for (const [matricule, mileage, interval] of [["V2-DEMO-001", 85400, 6000], ["V2-DEMO-002", 91000, 10000]] as const) {
    const truck = await db.truck.upsert({ where: { matricule_companyId: { matricule, companyId: company.id } }, update: {}, create: { matricule, companyId: company.id, marque: "Renault", modele: "Trafic" } })
    if (truck.mileageRevision === 0) {
      await executeMileageCommand(truck.id, "READING", { mileage, expectedRevision: 0 }, randomUUID(), deps)
      await updateMaintenancePlan(truck.id, { intervalKm: interval, intervalMonths: 12, expectedRevision: 0 }, deps)
      await recordMaintenance(truck.id, { kind: "OIL_CHANGE", occurredAt: "2026-07-01T00:00:00Z", mileage: 80000, notes: "Vidange et remplacement du filtre à huile" }, randomUUID(), deps)
    }
  }
  console.log("Local demo ready: vehicule-v2@example.test / Test-Vehicule-V2-2026")
} finally { await db.$disconnect() }

}
main().catch(error => { console.error(error); process.exitCode = 1 })
