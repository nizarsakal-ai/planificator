/**
 * LOT-1W-1a — Cœur d'`affecterEquipe` (hors "use server"), extrait à parité stricte de
 * `chantier.actions.ts` l.215–361 à BASE_SHA a84c73f : mêmes contrôles, même requête de conflit
 * équipe (`{ teamId, date: { in } }`, SANS filtre d'entreprise — parité, durcissement en 1W-1b),
 * même requête de conflit employés, même transaction (N `assignment.create`,
 * `employeeAssignment.createMany`, passage IN_PROGRESS, `notification.create`, lecture du chef et
 * de l'entreprise, e-mail fire-and-forget déclenché au même point, dans la transaction), mêmes
 * messages d'erreur au caractère près. Arithmétique de dates inchangée (`setHours(0,0,0,0)` dépend
 * du fuseau du processus — 1W-1b).
 *
 * Reste dans l'adaptateur : `requireAdmin`, la lecture du `FormData`, `revalidatePath`, le
 * `console.error` préfixé `[affecterEquipe]` et la fonction d'e-mail réelle (injectée ici en port).
 */

import type { WorksiteStatus } from "@prisma/client"
import type { CoreResult, WriteActor } from "@/lib/actions/write-actor"

/** Valeurs brutes du formulaire (`FormData.get`, typées `string` par l'adaptateur — `null` à l'exécution si absentes). */
export type AssignTeamInput = Readonly<{
  worksiteId: string
  teamId: string
  dateFrom: string
  dateTo: string
}>

export type AssignTeamData = {
  assignmentIds: string[]
  worksiteStatus: WorksiteStatus
  leaderUserId: string | null
}

// ---- Arguments Prisma, à l'identique de BASE_SHA (clés et ordre) --------------------------------

export type FindWorksiteArgs = { where: { id: string; companyId: string } }
export type FindTeamArgs = {
  where: { id: string; companyId: string }
  include: {
    members: { where: { leftAt: null }; select: { employeeId: true } }
    leader: { select: { userId: true } }
  }
}
export type FindTeamConflictArgs = {
  where: { teamId: string; date: { in: Date[] } }
  include: { worksite: { select: { name: true; address: true } } }
  orderBy: { date: "asc" }
}
export type FindEmployeeConflictsArgs = {
  where: { employeeId: { in: string[] }; date: { in: Date[] } }
  include: {
    employee: { select: { firstName: true; lastName: true } }
    assignment: { select: { worksite: { select: { name: true } }; team: { select: { name: true } } } }
  }
  orderBy: [{ employeeId: "asc" }, { date: "asc" }]
}

export type AssignmentCreatedEmailArgs = {
  to: string
  teamLeaderName: string
  worksiteName: string
  dateLabel: string
  companyName: string
}

/** Client transactionnel : sous-ensemble de `Prisma.TransactionClient` utilisé par le cœur. */
export type AssignTeamTx = {
  assignment: {
    create: (args: { data: { worksiteId: string; teamId: string; date: Date; status: "PENDING" } }) => Promise<{ id: string }>
  }
  employeeAssignment: {
    createMany: (args: { data: { assignmentId: string; employeeId: string; date: Date }[] }) => Promise<unknown>
  }
  worksite: {
    update: (args: { where: { id: string }; data: { status: "IN_PROGRESS" } }) => Promise<unknown>
  }
  notification: {
    create: (args: {
      data: { userId: string; companyId: string; type: "ASSIGNMENT_CREATED"; title: string; message: string; link: string }
    }) => Promise<unknown>
  }
  user: {
    findUnique: (args: { where: { id: string }; select: { email: true; name: true } }) => Promise<{ email: string | null; name: string | null } | null>
  }
  company: {
    findUnique: (args: { where: { id: string }; select: { name: true } }) => Promise<{ name: string } | null>
  }
}

export type AssignTeamDeps = {
  findWorksite: (args: FindWorksiteArgs) => Promise<{ id: string; name: string; status: WorksiteStatus } | null>
  findTeam: (args: FindTeamArgs) => Promise<{ members: { employeeId: string }[]; leader: { userId: string | null } | null } | null>
  findTeamConflict: (args: FindTeamConflictArgs) => Promise<{ date: Date; worksite: { name: string; address: string | null } } | null>
  findEmployeeConflicts: (args: FindEmployeeConflictsArgs) => Promise<
    { date: Date; employee: { firstName: string; lastName: string }; assignment: { worksite: { name: string }; team: { name: string } } }[]
  >
  /** `prisma.$transaction(fn)` : rejette si `fn` lève (rollback). */
  transaction: <T>(fn: (tx: AssignTeamTx) => Promise<T>) => Promise<T>
  /** `sendAssignmentCreatedEmail` réel, injecté par l'adaptateur ; appelé en fire-and-forget avec `.catch(() => {})`. */
  sendAssignmentCreatedEmail: (args: AssignmentCreatedEmailArgs) => Promise<unknown>
}

// ---- Cœur ----------------------------------------------------------------------------------------

export async function assignTeamCore(
  input: AssignTeamInput,
  actor: WriteActor,
  deps: AssignTeamDeps
): Promise<CoreResult<AssignTeamData>> {
  const worksiteId  = input.worksiteId
  const teamId      = input.teamId
  const dateFromStr = input.dateFrom
  const dateToStr   = input.dateTo

  if (!worksiteId || !teamId || !dateFromStr) {
    return { ok: false, code: "VALIDATION", details: { message: "Informations manquantes." } }
  }

  const dateFrom = new Date(dateFromStr); dateFrom.setHours(0, 0, 0, 0)
  const dateTo   = dateToStr ? new Date(dateToStr) : new Date(dateFrom)
  dateTo.setHours(0, 0, 0, 0)

  if (dateTo < dateFrom) return { ok: false, code: "VALIDATION", details: { message: "La date de fin doit être après la date de début." } }

  // Construire la liste des jours de la plage
  const dates: Date[] = []
  const cursor = new Date(dateFrom)
  while (cursor <= dateTo) {
    dates.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }

  // Vérifier que le chantier appartient à l'entreprise
  const worksite = await deps.findWorksite({
    where: { id: worksiteId, companyId: actor.companyId },
  })
  if (!worksite) return { ok: false, code: "WORKSITE_NOT_FOUND", details: { message: "Chantier introuvable." } }

  // Vérifier que l'équipe appartient à l'entreprise
  const team = await deps.findTeam({
    where: { id: teamId, companyId: actor.companyId },
    include: {
      members: { where: { leftAt: null }, select: { employeeId: true } },
      leader:  { select: { userId: true } },
    },
  })
  if (!team) return { ok: false, code: "TEAM_NOT_FOUND", details: { message: "Équipe introuvable." } }

  const memberIds = team.members.map((m) => m.employeeId)

  // Vérifier les conflits sur toute la plage
  const conflitEquipe = await deps.findTeamConflict({
    where: { teamId, date: { in: dates } },
    include: { worksite: { select: { name: true, address: true } } },
    orderBy: { date: "asc" },
  })
  if (conflitEquipe) {
    const d = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(conflitEquipe.date)
    const lieu = conflitEquipe.worksite.address ? ` (${conflitEquipe.worksite.address})` : ""
    return {
      ok: false,
      code: "TEAM_CONFLICT",
      details: {
        message: `Cette équipe est déjà affectée le ${d} au chantier « ${conflitEquipe.worksite.name} »${lieu}. Libérez-la de ce chantier avant de la réaffecter.`,
      },
    }
  }

  if (memberIds.length > 0) {
    const conflitsEmployes = await deps.findEmployeeConflicts({
      where: { employeeId: { in: memberIds }, date: { in: dates } },
      include: {
        employee:   { select: { firstName: true, lastName: true } },
        assignment: { select: { worksite: { select: { name: true } }, team: { select: { name: true } } } },
      },
      orderBy: [{ employeeId: "asc" }, { date: "asc" }],
    })
    if (conflitsEmployes.length > 0) {
      const fmt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" })
      const lignes = conflitsEmployes.map((c) => {
        const nom = `${c.employee.firstName} ${c.employee.lastName}`
        return `${nom} est affecté le ${fmt.format(c.date)} au chantier « ${c.assignment.worksite.name} » avec l'équipe ${c.assignment.team.name}.`
      })
      return {
        ok: false,
        code: "EMPLOYEE_CONFLICT",
        details: {
          message: `${lignes.join("\n")}\nDésaffectez-${conflitsEmployes.length > 1 ? "les" : "le"} avant de réaffecter l'équipe.`,
        },
      }
    }
  }

  // Créer une affectation par jour
  const assignmentIds: string[] = []
  try { await deps.transaction(async (tx) => {
    for (const date of dates) {
      const assignment = await tx.assignment.create({
        data: { worksiteId, teamId, date, status: "PENDING" },
      })
      assignmentIds.push(assignment.id)
      if (memberIds.length > 0) {
        await tx.employeeAssignment.createMany({
          data: memberIds.map((employeeId) => ({
            assignmentId: assignment.id,
            employeeId,
            date,
          })),
        })
      }
    }

    // Passer le chantier en IN_PROGRESS si encore PLANNED
    if (worksite.status === "PLANNED") {
      await tx.worksite.update({
        where: { id: worksiteId },
        data: { status: "IN_PROGRESS" },
      })
    }

    // Notifier le chef d'équipe (une seule notification pour toute la plage)
    if (team.leader?.userId) {
      const fromLabel = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(dateFrom)
      const toLabel   = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" }).format(dateTo)
      const rangeLabel = dates.length === 1 ? fromLabel : `du ${fromLabel} au ${toLabel}`

      await tx.notification.create({
        data: {
          userId:    team.leader.userId,
          companyId: actor.companyId,
          type:      "ASSIGNMENT_CREATED",
          title:     `Nouvelle affectation — ${worksite.name}`,
          message:   `Votre équipe est affectée ${rangeLabel}. Confirmez ou refusez.`,
          link:      `/planning`,
        },
      })

      const leaderUser = await tx.user.findUnique({
        where:  { id: team.leader.userId },
        select: { email: true, name: true },
      })
      if (leaderUser?.email) {
        const company = await tx.company.findUnique({ where: { id: actor.companyId }, select: { name: true } })
        deps.sendAssignmentCreatedEmail({
          to:             leaderUser.email,
          teamLeaderName: leaderUser.name ?? leaderUser.email,
          worksiteName:   worksite.name,
          dateLabel:      rangeLabel,
          companyName:    company?.name ?? "",
        }).catch(() => {})
      }
    }
  }) } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const databaseError = err && typeof err === "object" && "meta" in err
      ? String((err as {meta?: {database_error?: unknown}}).meta?.database_error ?? "") : ""
    const conflict = `${msg} ${databaseError}`.match(/\bDAILY_(TEAM|DRIVER)_PLANNING_CONFLICT\b/)
    if (conflict) return {
      ok: false,
      code: conflict[1] === "TEAM" ? "TEAM_CONFLICT" : "EMPLOYEE_CONFLICT",
      details: { message: conflict[1] === "TEAM"
        ? "Cette équipe est déjà réservée pour une tournée sur cette période. Modifiez l’équipe ou les dates."
        : "Un chauffeur est déjà réservé pour une tournée sur cette période. Modifiez l’équipe ou les dates." },
    }
    return {
      ok: false,
      code: "TRANSACTION_FAILED",
      details: { message: "Erreur lors de la création des affectations. Veuillez réessayer.", cause: msg },
    }
  }

  return {
    ok: true,
    data: {
      assignmentIds,
      worksiteStatus: worksite.status === "PLANNED" ? "IN_PROGRESS" : worksite.status,
      leaderUserId: team.leader?.userId ?? null,
    },
  }
}
