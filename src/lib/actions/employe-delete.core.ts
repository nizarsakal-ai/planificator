/**
 * Suppression employé — logique testable (hors fichier "use server").
 *
 * V1B-db : un employé référencé par l'historique véhicule (TruckAssignment.chauffeurId) ou par un camion
 * (Truck.chauffeurId) ne peut pas être supprimé physiquement (archivage = toggleEmployeActive).
 * Le contrôle précède toute écriture ; la DB (FK RESTRICT) reste le dernier rempart.
 */

export const EMPLOYEE_HAS_VEHICLE_HISTORY = "EMPLOYEE_HAS_VEHICLE_HISTORY"

export const EMPLOYEE_HAS_VEHICLE_HISTORY_MESSAGE =
  "Cet employé figure dans l'historique d'un véhicule et ne peut pas être supprimé. Archivez-le plutôt."

export type DeleteEmployeDeps = {
  requireSession: () => Promise<{ companyId: string | null; role: string }>
  findEmployee: (args: {
    id: string
    companyId: string
  }) => Promise<{ id: string; userId: string } | null>
  /** Vrai si l'employé (du tenant) est chauffeur d'une période d'historique ou d'un camion. */
  hasVehicleHistory: (args: { employeeId: string; companyId: string }) => Promise<boolean>
  /** Affectations de planning + fiche employé, dans UNE transaction (tout ou rien). */
  deleteEmployeeRecords: (employeeId: string) => Promise<unknown>
  deleteUser: (userId: string) => Promise<unknown>
  revalidate: () => void
}

/**
 * P2003 imputable à l'historique véhicule : uniquement si la contrainte violée, lorsque Prisma la nomme,
 * est une FK véhicule, ET si la relecture confirme une référence véhicule. Une autre FK (Team.leaderId…)
 * n'est jamais présentée comme une erreur véhicule.
 */
export function isVehicleHistoryForeignKeyViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const { code, meta } = err as { code?: unknown; meta?: { field_name?: unknown; constraint?: unknown } }
  if (code !== "P2003") return false
  const named = [meta?.field_name, meta?.constraint].flatMap((v) => (Array.isArray(v) ? v : [v])).filter(
    (v): v is string => typeof v === "string"
  )
  if (named.length === 0) return true // contrainte non nommée : la relecture tranche
  return named.some((n) => /truck_assignments|trucks_chauffeurId/.test(n))
}

export async function deleteEmployeImpl(
  employeeId: string,
  deps: DeleteEmployeDeps
) {
  try {
    const user = await deps.requireSession()
    if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(user.role)) {
      throw new Error("Accès refusé")
    }
    if (!user.companyId) throw new Error("Entreprise introuvable")
    const companyId = user.companyId

    const employee = await deps.findEmployee({ id: employeeId, companyId })
    if (!employee) return { error: "Employé introuvable" }

    const refused = {
      error: EMPLOYEE_HAS_VEHICLE_HISTORY_MESSAGE,
      code: EMPLOYEE_HAS_VEHICLE_HISTORY,
    } as const

    if (await deps.hasVehicleHistory({ employeeId: employee.id, companyId })) return refused

    try {
      await deps.deleteEmployeeRecords(employee.id)
    } catch (err) {
      if (
        isVehicleHistoryForeignKeyViolation(err) &&
        (await deps.hasVehicleHistory({ employeeId: employee.id, companyId }))
      ) {
        return refused
      }
      throw err
    }

    if (employee.userId) {
      try {
        await deps.deleteUser(employee.userId)
      } catch (_e) {}
    }

    deps.revalidate()
    return { success: true }
  } catch (error) {
    console.error("deleteEmploye error:", error)
    return { error: "Erreur lors de la suppression" }
  }
}
