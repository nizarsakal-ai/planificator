// VEHICLES V1B-db — suppression Employee protégée par l'historique véhicule (aucune connexion DB).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  deleteEmployeImpl,
  EMPLOYEE_HAS_VEHICLE_HISTORY,
  EMPLOYEE_HAS_VEHICLE_HISTORY_MESSAGE,
  isVehicleHistoryForeignKeyViolation,
  type DeleteEmployeDeps,
} from "@/lib/actions/employe-delete.core"

const p2003 = (field?: string) =>
  Object.assign(new Error("Foreign key constraint violated"), { code: "P2003", meta: field ? { field_name: field } : {} })

function setup(opts: { history?: boolean | (() => boolean); recordsError?: unknown; companyId?: string; role?: string } = {}) {
  const log: string[] = []
  // Mini-base : planning + employé. La transaction est tout-ou-rien.
  const db = { assignments: 1, employee: true }
  const deps: DeleteEmployeDeps = {
    requireSession: async () => ({ companyId: opts.companyId ?? "co-a", role: opts.role ?? "ADMIN" }),
    findEmployee: async ({ id, companyId }) => {
      log.push(`find:${companyId}`)
      return id === "emp-1" && companyId === "co-a" ? { id: "emp-1", userId: "user-1" } : null
    },
    hasVehicleHistory: async ({ employeeId, companyId }) => {
      log.push(`history:${employeeId}:${companyId}`)
      return typeof opts.history === "function" ? opts.history() : (opts.history ?? false)
    },
    deleteEmployeeRecords: async () => {
      log.push("records")
      const snapshot = { ...db }
      try {
        db.assignments = 0
        if (opts.recordsError) throw opts.recordsError
        db.employee = false
      } catch (e) {
        Object.assign(db, snapshot) // rollback
        throw e
      }
    },
    deleteUser: async () => {
      log.push("user")
    },
    revalidate: () => log.push("revalidate"),
  }
  return { deps, log, db }
}

describe("suppression Employee — historique véhicule", () => {
  it("référencé → refus contrôlé AVANT toute écriture", async () => {
    const { deps, log, db } = setup({ history: true })
    const r = await deleteEmployeImpl("emp-1", deps)
    assert.deepEqual(r, { error: EMPLOYEE_HAS_VEHICLE_HISTORY_MESSAGE, code: EMPLOYEE_HAS_VEHICLE_HISTORY })
    assert.equal(EMPLOYEE_HAS_VEHICLE_HISTORY_MESSAGE, "Cet employé figure dans l'historique d'un véhicule et ne peut pas être supprimé. Archivez-le plutôt.")
    assert.ok(!log.includes("records") && !log.includes("user") && !log.includes("revalidate"))
    assert.deepEqual(db, { assignments: 1, employee: true })
  })

  it("le contrôle utilise le tenant de la session", async () => {
    const { deps, log } = setup({ history: false })
    await deleteEmployeImpl("emp-1", deps)
    assert.ok(log.includes("history:emp-1:co-a"))
    assert.ok(log.indexOf("history:emp-1:co-a") < log.indexOf("records"))
  })

  it("autre tenant → introuvable, aucun contrôle ni écriture", async () => {
    const { deps, log } = setup({ companyId: "co-b" })
    assert.deepEqual(await deleteEmployeImpl("emp-1", deps), { error: "Employé introuvable" })
    assert.ok(!log.some((l) => l.startsWith("history") || l === "records"))
  })

  it("sans historique → succès (records, puis user, puis revalidate)", async () => {
    const { deps, log } = setup()
    assert.deepEqual(await deleteEmployeImpl("emp-1", deps), { success: true })
    assert.deepEqual(log.filter((l) => ["records", "user", "revalidate"].includes(l)), ["records", "user", "revalidate"])
  })

  it("course : P2003 véhicule + historique confirmé → refus métier, planning intact (rollback)", async () => {
    let calls = 0
    const { deps, db } = setup({ history: () => ++calls > 1, recordsError: p2003("truck_assignments_chauffeurId_fkey (index)") })
    const r = await deleteEmployeImpl("emp-1", deps)
    assert.equal((r as { code?: string }).code, EMPLOYEE_HAS_VEHICLE_HISTORY)
    assert.deepEqual(db, { assignments: 1, employee: true })
  })

  it("P2003 d'une autre FK (Team.leaderId) → jamais présenté comme erreur véhicule", async () => {
    const { deps, log, db } = setup({ history: true, recordsError: p2003("teams_leaderId_fkey (index)") })
    // historique présent MAIS contrainte nommée = équipe : pas de faux mapping ; garde amont déjà refusé → forcer le chemin P2003
    let first = true
    deps.hasVehicleHistory = async () => {
      const v = !first
      first = false
      return v
    }
    const r = await deleteEmployeImpl("emp-1", deps)
    assert.deepEqual(r, { error: "Erreur lors de la suppression" })
    assert.deepEqual(db, { assignments: 1, employee: true })
    assert.ok(!log.includes("user"))
  })

  it("P2003 sans historique démontré → erreur générique", async () => {
    const { deps } = setup({ history: false, recordsError: p2003() })
    assert.deepEqual(await deleteEmployeImpl("emp-1", deps), { error: "Erreur lors de la suppression" })
  })

  it("isVehicleHistoryForeignKeyViolation : seuls P2003 véhicule ou non nommés", () => {
    assert.equal(isVehicleHistoryForeignKeyViolation(p2003("truck_assignments_chauffeurId_fkey")), true)
    assert.equal(isVehicleHistoryForeignKeyViolation(p2003("trucks_chauffeurId_fkey")), true)
    assert.equal(isVehicleHistoryForeignKeyViolation(p2003()), true)
    assert.equal(isVehicleHistoryForeignKeyViolation(p2003("teams_leaderId_fkey")), false)
    assert.equal(isVehicleHistoryForeignKeyViolation(Object.assign(new Error("x"), { code: "P2002" })), false)
    assert.equal(isVehicleHistoryForeignKeyViolation(null), false)
  })

  it("rôle EMPLOYEE refusé, TEAM_LEADER conservé", async () => {
    assert.deepEqual(await deleteEmployeImpl("emp-1", setup({ role: "EMPLOYEE" }).deps), { error: "Erreur lors de la suppression" })
    assert.deepEqual(await deleteEmployeImpl("emp-1", setup({ role: "TEAM_LEADER" }).deps), { success: true })
  })

  it("l'archivage n'est pas concerné : toggleEmployeActive ne contient aucun contrôle ni suppression", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/lib/actions/employe.actions.ts", "utf8")
    const fn = src.slice(src.indexOf("export async function toggleEmployeActive"), src.indexOf("export async function deleteEmploye"))
    assert.ok(fn.includes("prisma.employee.update") && fn.includes("prisma.user.update"))
    assert.ok(!/delete|hasVehicleHistory/.test(fn))
  })

  it("câblage : transaction planning+employé, historique = TruckAssignment OU Truck du tenant", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/lib/actions/employe.actions.ts", "utf8")
    const fn = src.slice(src.indexOf("export async function deleteEmploye("))
    assert.ok(/prisma\.\$transaction\(\[\s*prisma\.employeeAssignment\.deleteMany[\s\S]*prisma\.employee\.delete/.test(fn))
    assert.ok(fn.includes("prisma.truckAssignment.count({ where: { chauffeurId: id, companyId } })"))
    assert.ok(fn.includes("prisma.truck.count({ where: { chauffeurId: id, companyId } })"))
  })
})
