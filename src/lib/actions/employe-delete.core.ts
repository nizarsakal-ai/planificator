/**
 * Suppression employé — logique testable (hors fichier "use server").
 */

export type DeleteEmployeDeps = {
  requireSession: () => Promise<{ companyId: string | null; role: string }>
  findEmployee: (args: {
    id: string
    companyId: string
  }) => Promise<{ id: string; userId: string } | null>
  deleteAssignments: (employeeId: string) => Promise<unknown>
  deleteEmployee: (employeeId: string) => Promise<unknown>
  deleteUser: (userId: string) => Promise<unknown>
  revalidate: () => void
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

    await deps.deleteAssignments(employee.id)
    await deps.deleteEmployee(employee.id)

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
