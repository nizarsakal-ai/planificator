/**
 * IA-6 : l'assistant pour chaque rôle, limité à ses propres droits. Un employé ne lit que SON planning et SES absences,
 * un chef d'équipe en plus les équipes qu'il dirige, un client seulement SES chantiers. Les identifiants (fiche employé,
 * fiche client) sont résolus côté serveur depuis la session, jamais fournis par le modèle. Lecture seule.
 * Ouverture progressive : COPILOT_ROLES liste les rôles autorisés (par défaut ADMIN et SUPER_ADMIN seulement).
 */
import type { PrismaClient } from "@prisma/client"
import type Anthropic from "@anthropic-ai/sdk"
import { CopilotToolInputError, parseDay, parseRange, MAX_ROWS } from "@/lib/copilot/copilot-tools"
import { CLIENT_LINK_MESSAGE, resolveClientLink } from "@/lib/client-portal/client-link"

type Env = Record<string, string | undefined>
type Db = Pick<PrismaClient, "employee" | "employeeAssignment" | "absence" | "assignment" | "teamMember" | "worksite" | "clientProfile" | "client">

export type CopilotRole = "SUPER_ADMIN" | "ADMIN" | "TEAM_LEADER" | "EMPLOYEE" | "CLIENT"
export const ALL_ROLES: readonly CopilotRole[] = ["SUPER_ADMIN", "ADMIN", "TEAM_LEADER", "EMPLOYEE", "CLIENT"]
export const ROLE_LABEL: Record<CopilotRole, string> = {
  SUPER_ADMIN: "administrateur", ADMIN: "administrateur", TEAM_LEADER: "chef d'équipe", EMPLOYEE: "employé", CLIENT: "client",
}
export const isAdminRole = (role: CopilotRole) => role === "ADMIN" || role === "SUPER_ADMIN"

/** Rôles ouverts au copilote. Valeur absente ou vide : administration seulement. Les rôles inconnus sont ignorés. */
export function allowedCopilotRoles(env: Env = process.env): Set<CopilotRole> {
  const raw = env.COPILOT_ROLES?.trim()
  if (!raw) return new Set(["ADMIN", "SUPER_ADMIN"])
  const roles = raw.split(",").map(r => r.trim().toUpperCase()).filter((r): r is CopilotRole => (ALL_ROLES as readonly string[]).includes(r))
  return new Set(roles)
}
export function isCopilotRoleAllowed(role: unknown, env: Env = process.env): role is CopilotRole {
  return typeof role === "string" && allowedCopilotRoles(env).has(role as CopilotRole)
}

export interface RoleContext { role: CopilotRole; companyId: string; userId: string; employeeId: string | null; clientId: string | null; email?: string | null; clientLinkIssue?: "NONE" | "AMBIGUOUS" }

/** Fiche employé (rôles internes) ou fiche client (rôle client) de l'utilisateur, dans la société de la session. */
export async function resolveRoleContext(db: Db, user: { id: string; companyId: string; role: CopilotRole; email?: string | null }): Promise<RoleContext> {
  const base: RoleContext = { role: user.role, companyId: user.companyId, userId: user.id, employeeId: null, clientId: null, email: user.email ?? null }
  if (user.role === "EMPLOYEE" || user.role === "TEAM_LEADER") {
    const e = await db.employee.findFirst({ where: { userId: user.id, companyId: user.companyId, active: true }, select: { id: true } })
    return { ...base, employeeId: e?.id ?? null }
  }
  if (user.role === "CLIENT") {
    // Règle commune avec le portail client : lien explicite prioritaire, courriel accepté seulement s'il est sans ambiguïté.
    const link = await resolveClientLink(db, user)
    return link.ok ? { ...base, clientId: link.clientId } : { ...base, clientLinkIssue: link.reason }
  }
  return base
}

const rangeSchema = { type: "object" as const, properties: { debut: { type: "string", description: "AAAA-MM-JJ" }, fin: { type: "string", description: "AAAA-MM-JJ" } }, required: ["debut", "fin"] }
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

const T: Record<string, Anthropic.Tool> = {
  mon_planning: { name: "mon_planning", description: "Mes affectations (chantier, adresse, équipe, statut) sur une période, jours inclus.", input_schema: rangeSchema },
  mes_absences: { name: "mes_absences", description: "Mes absences à venir et mes demandes en attente.", input_schema: { type: "object", properties: {} } },
  planning_equipe: { name: "planning_equipe", description: "Affectations des équipes que je dirige sur une période (date, équipe, chantier, statut de confirmation).", input_schema: rangeSchema },
  affectations_a_confirmer: { name: "affectations_a_confirmer", description: "Affectations de mes équipes en attente de ma confirmation, à partir d'aujourd'hui.", input_schema: { type: "object", properties: {} } },
  absences_equipe: { name: "absences_equipe", description: "Absences des membres de mes équipes qui chevauchent une période (qui, quand, validée ou en attente ; le motif n'est pas communiqué).", input_schema: rangeSchema },
  mes_chantiers: { name: "mes_chantiers", description: "Mes chantiers (statut, dates, adresse) et les prochaines interventions prévues.", input_schema: { type: "object", properties: {} } },
}

/** Outils de lecture par rôle non administrateur (les administrateurs gardent tous les outils de la société). */
export const ROLE_TOOLS: Record<"TEAM_LEADER" | "EMPLOYEE" | "CLIENT", Anthropic.Tool[]> = {
  EMPLOYEE: [T.mon_planning, T.mes_absences],
  TEAM_LEADER: [T.mon_planning, T.mes_absences, T.planning_equipe, T.affectations_a_confirmer, T.absences_equipe],
  CLIENT: [T.mes_chantiers],
}
export const ROLE_TOOL_NAMES = new Set(Object.keys(T))

type Handler = (db: Db, ctx: RoleContext, input: Record<string, unknown>, today: Date) => Promise<unknown>

const needEmployee = (ctx: RoleContext) => {
  if (!ctx.employeeId) throw new CopilotToolInputError("Aucune fiche employé active n'est liée à votre compte : demandez à votre administrateur.")
  return ctx.employeeId
}

const handlers: Record<string, Handler> = {
  async mon_planning(db, ctx, input) {
    const { from, to } = parseRange(input)
    const rows = await db.employeeAssignment.findMany({
      where: { employeeId: needEmployee(ctx), date: { gte: from, lte: to }, employee: { companyId: ctx.companyId } },
      orderBy: { date: "asc" }, take: MAX_ROWS,
      select: { date: true, assignment: { select: { status: true, team: { select: { name: true } }, worksite: { select: { name: true, address: true } } } } },
    })
    return rows.map(r => ({ date: day(r.date), chantier: r.assignment.worksite.name, adresse: r.assignment.worksite.address, equipe: r.assignment.team.name, statut: r.assignment.status, lien: "/planning/moi" }))
  },
  async mes_absences(db, ctx, _input, today) {
    const rows = await db.absence.findMany({
      where: { employeeId: needEmployee(ctx), companyId: ctx.companyId, OR: [{ endDate: { gte: today } }, { status: "PENDING" }] },
      orderBy: { startDate: "asc" }, take: MAX_ROWS, select: { type: true, status: true, startDate: true, endDate: true },
    })
    return rows.map(a => ({ type: a.type, statut: a.status, debut: day(a.startDate), fin: day(a.endDate), lien: "/mes-absences" }))
  },
  async planning_equipe(db, ctx, input) {
    const { from, to } = parseRange(input)
    const rows = await db.assignment.findMany({
      where: { date: { gte: from, lte: to }, team: { leaderId: needEmployee(ctx), companyId: ctx.companyId } },
      orderBy: { date: "asc" }, take: MAX_ROWS * 2,
      select: { date: true, status: true, team: { select: { name: true } }, worksite: { select: { name: true, address: true } } },
    })
    return rows.map(a => ({ date: day(a.date), equipe: a.team.name, chantier: a.worksite.name, adresse: a.worksite.address, statut: a.status, lien: "/planning/equipe" }))
  },
  async affectations_a_confirmer(db, ctx, _input, today) {
    const rows = await db.assignment.findMany({
      where: { status: "PENDING", date: { gte: today }, team: { leaderId: needEmployee(ctx), companyId: ctx.companyId } },
      orderBy: { date: "asc" }, take: MAX_ROWS,
      select: { date: true, team: { select: { name: true } }, worksite: { select: { name: true } } },
    })
    return rows.map(a => ({ date: day(a.date), equipe: a.team.name, chantier: a.worksite.name, lien: "/planning/equipe" }))
  },
  async absences_equipe(db, ctx, input) {
    const { from, to } = parseRange(input)
    const members = await db.teamMember.findMany({
      where: { leftAt: null, team: { leaderId: needEmployee(ctx), companyId: ctx.companyId } }, take: 200, select: { employeeId: true },
    })
    const ids = [...new Set(members.map(m => m.employeeId))]
    if (!ids.length) return []
    const rows = await db.absence.findMany({
      where: { companyId: ctx.companyId, employeeId: { in: ids }, status: { in: ["APPROVED", "PENDING"] }, startDate: { lte: to }, endDate: { gte: from } },
      orderBy: { startDate: "asc" }, take: MAX_ROWS,
      // Minimisation (revue Codex IA-6) : le motif de l'absence (maladie, congé…) n'est ni lu ni envoyé au fournisseur d'IA.
      select: { status: true, startDate: true, endDate: true, employee: { select: { firstName: true, lastName: true } } },
    })
    return rows.map(a => ({ employe: `${a.employee.firstName} ${a.employee.lastName}`.trim(), statut: a.status, debut: day(a.startDate), fin: day(a.endDate) }))
  },
  async mes_chantiers(db, ctx, _input, today) {
    if (!ctx.clientId) throw new CopilotToolInputError(CLIENT_LINK_MESSAGE[ctx.clientLinkIssue ?? "NONE"])
    const rows = await db.worksite.findMany({
      where: { clientId: ctx.clientId, companyId: ctx.companyId, status: { not: "ARCHIVED" } },
      orderBy: { startDate: "asc" }, take: MAX_ROWS,
      select: {
        id: true, name: true, status: true, startDate: true, endDate: true, address: true,
        assignments: { where: { date: { gte: today } }, orderBy: { date: "asc" }, take: 10, select: { date: true, team: { select: { name: true } } } },
      },
    })
    return rows.map(w => ({
      nom: w.name, statut: w.status, debut: day(w.startDate), fin: day(w.endDate), adresse: w.address, lien: `/mes-chantiers/${w.id}`,
      prochaines_interventions: w.assignments.map(a => ({ date: day(a.date), equipe: a.team.name })),
    }))
  },
}

/** Exécute un outil de rôle, seulement s'il appartient aux outils de CE rôle. */
export async function runRoleTool(db: Db, ctx: RoleContext, name: string, input: unknown, today: Date): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const allowed = isAdminRole(ctx.role) ? [] : ROLE_TOOLS[ctx.role]
  if (!allowed.some(t => t.name === name) || !ctx.companyId) return { ok: false, error: "Outil indisponible pour votre rôle." }
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  try {
    return { ok: true, result: await handlers[name](db, ctx, args, today) }
  } catch (error) {
    if (error instanceof CopilotToolInputError) return { ok: false, error: error.message }
    throw error
  }
}

/** Consignes propres au rôle (les administrateurs gardent les consignes générales). */
export function roleRules(role: CopilotRole): string[] {
  switch (role) {
    case "EMPLOYEE": return [
      "Tu aides un employé : tu ne connais que SON planning et SES absences (outils mon_planning, mes_absences).",
      "Pour poser une absence ou une note de frais, explique la rubrique « Mes absences » ou « Mes notes de frais » : tu ne peux rien créer.",
    ]
    case "TEAM_LEADER": return [
      "Tu aides un chef d'équipe : son planning, ses absences, et les équipes qu'il dirige (planning, affectations à confirmer, absences des membres).",
      "Il confirme ou refuse lui-même les affectations dans le planning : explique où, tu ne peux rien modifier.",
    ]
    case "CLIENT": return [
      "Tu aides un client de l'entreprise : tu ne connais que SES chantiers et les prochaines interventions prévues (outil mes_chantiers).",
      "Ne parle jamais d'autres clients, des équipes au-delà de leur nom, des prix internes ni des données de l'entreprise. Pour toute demande commerciale, invite-le à contacter son interlocuteur.",
    ]
    default: return []
  }
}

// Réexport utile aux tests.
export { parseDay }
