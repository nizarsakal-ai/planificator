export type AssignmentRow = {
  id: string
  date: Date
  status: string
  teamId: string
  team: { name: string; color: string | null }
  employeeAssignments: {
    employee: { id: string; firstName: string; lastName: string }
  }[]
}

export type AssignmentBlock = {
  teamId: string
  teamName: string
  teamColor: string | null
  startDate: Date
  endDate: Date
  status: "CONFIRMED" | "PENDING" | "REFUSED"
  employees: { id: string; firstName: string; lastName: string }[]
  dayCount: number
}

/** Regroupe les affectations journalières en blocs continus par équipe. */
export function groupAssignmentBlocks(assignments: AssignmentRow[]): AssignmentBlock[] {
  if (assignments.length === 0) return []

  const sorted = [...assignments].sort((a, b) => {
    const t = a.teamId.localeCompare(b.teamId)
    if (t !== 0) return t
    return a.date.getTime() - b.date.getTime()
  })

  const statusPriority: Record<string, number> = { REFUSED: 3, PENDING: 2, CONFIRMED: 1 }
  const blocks: AssignmentBlock[] = []

  for (const a of sorted) {
    const last = blocks[blocks.length - 1]
    const sameTeam = last?.teamId === a.teamId
    const diffMs = sameTeam ? a.date.getTime() - last!.endDate.getTime() : Infinity
    const isConsec = diffMs <= 86400000

    if (sameTeam && isConsec) {
      last!.endDate = a.date
      last!.dayCount++
      const sp = statusPriority[a.status] ?? 0
      if (sp > (statusPriority[last!.status] ?? 0)) {
        last!.status = a.status as "CONFIRMED" | "PENDING" | "REFUSED"
      }
      for (const ea of a.employeeAssignments) {
        if (!last!.employees.find((e) => e.id === ea.employee.id)) {
          last!.employees.push(ea.employee)
        }
      }
    } else {
      blocks.push({
        teamId: a.teamId,
        teamName: a.team.name,
        teamColor: a.team.color,
        startDate: a.date,
        endDate: a.date,
        status: a.status as "CONFIRMED" | "PENDING" | "REFUSED",
        employees: a.employeeAssignments.map((ea) => ea.employee),
        dayCount: 1,
      })
    }
  }

  return blocks.sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
}
