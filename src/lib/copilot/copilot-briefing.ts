/**
 * IA-3 : briefing du jour et veille. Calcul DÉTERMINISTE (aucun appel à l'IA, aucun coût, aucune écriture) sur la
 * société de la session : la journée (chantiers, équipes libres, absents) et des alertes classées par urgence, chacune
 * avec un lien. L'assistant peut ensuite le commenter et proposer des actions (IA-2), toujours à confirmer.
 */
import type { PrismaClient, Prisma } from "@prisma/client"

type Db = Pick<PrismaClient, "assignment" | "team" | "absence" | "invoice" | "worksite" | "stockLevel" | "worksiteImportDraft">

export type AlertLevel = "urgent" | "attention" | "info"
export interface BriefingAlert { id: string; level: AlertLevel; title: string; detail: string; href: string }
export interface Briefing {
  date: string
  today: { worksites: Array<{ name: string; teams: string[]; href: string }>; freeTeams: string[]; absent: string[] }
  alerts: BriefingAlert[]
}

const DAY_MS = 86_400_000
const LEVEL_ORDER: Record<AlertLevel, number> = { urgent: 0, attention: 1, info: 2 }
const eur = (v: number) => v.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })
const sum = (rows: Array<{ totalTTC: Prisma.Decimal | number }>) => rows.reduce((t, r) => t + Number(r.totalTTC), 0)
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`
const list = (names: string[], max = 3) => names.slice(0, max).join(", ") + (names.length > max ? ` et ${names.length - max} autre(s)` : "")

export async function buildBriefing(db: Db, companyId: string, today: Date): Promise<Briefing> {
  if (!companyId) throw new Error("companyId obligatoire")
  const tomorrow = new Date(today.getTime() + DAY_MS)
  const in7 = new Date(today.getTime() + 7 * DAY_MS)
  const openInvoice = { companyId, kind: "INVOICE" as const, status: { in: ["SENT", "PARTIAL"] as ("SENT" | "PARTIAL")[] } }

  const [todayAssignments, teams, absentToday, overdue, dueSoon, pendingSoon, refusedAhead, startingSoon, overrun, absencesToValidate, stock, drafts] = await Promise.all([
    db.assignment.findMany({ where: { date: today, worksite: { companyId } }, take: 200, select: { teamId: true, team: { select: { name: true } }, worksite: { select: { id: true, name: true } } } }),
    db.team.findMany({ where: { companyId, active: true }, take: 200, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.absence.findMany({ where: { companyId, status: "APPROVED", startDate: { lte: today }, endDate: { gte: today } }, take: 100, select: { employee: { select: { firstName: true, lastName: true } } } }),
    db.invoice.findMany({ where: { ...openInvoice, dueDate: { lt: today } }, take: 500, select: { totalTTC: true } }),
    db.invoice.findMany({ where: { ...openInvoice, dueDate: { gte: today, lte: in7 } }, take: 500, select: { totalTTC: true } }),
    db.assignment.findMany({ where: { status: "PENDING", date: { gte: today, lte: tomorrow }, worksite: { companyId } }, take: 100, select: { team: { select: { name: true } } } }),
    db.assignment.findMany({ where: { status: "REFUSED", date: { gte: today, lte: in7 }, worksite: { companyId } }, take: 100, orderBy: { date: "asc" }, select: { date: true, team: { select: { name: true } }, worksite: { select: { id: true, name: true } } } }),
    db.worksite.findMany({ where: { companyId, status: { in: ["PLANNED", "DELAYED"] }, startDate: { gte: today, lte: in7 } }, take: 100, select: { id: true, name: true, startDate: true, _count: { select: { assignments: true } } } }),
    db.worksite.findMany({ where: { companyId, status: { in: ["IN_PROGRESS", "EXTENDED"] }, endDate: { lt: today } }, take: 100, select: { id: true, name: true } }),
    db.absence.count({ where: { companyId, status: "PENDING" } }),
    db.stockLevel.findMany({ where: { companyId, minQuantityMilli: { gt: 0 } }, take: 1000, select: { quantityMilli: true, minQuantityMilli: true } }),
    db.worksiteImportDraft.count({ where: { companyId, status: "PENDING_REVIEW" } }),
  ])

  const byWorksite = new Map<string, { name: string; teams: string[]; href: string }>()
  for (const a of todayAssignments) {
    const w = byWorksite.get(a.worksite.id) ?? { name: a.worksite.name, teams: [], href: `/chantiers/${a.worksite.id}` }
    w.teams.push(a.team.name)
    byWorksite.set(a.worksite.id, w)
  }
  const busy = new Set(todayAssignments.map(a => a.teamId))

  const alerts: BriefingAlert[] = []
  if (overdue.length) alerts.push({ id: "overdue", level: "urgent", title: `${plural(overdue.length, "facture en retard", "factures en retard")}`, detail: `${eur(sum(overdue))} TTC à encaisser, échéance dépassée.`, href: "/factures" })
  if (refusedAhead.length) alerts.push({ id: "refused", level: "urgent", title: `${plural(refusedAhead.length, "affectation refusée", "affectations refusées")} cette semaine`, detail: `À replanifier : ${list(refusedAhead.map(r => `${r.team.name} sur ${r.worksite.name} le ${r.date.toISOString().slice(0, 10)}`), 2)}.`, href: `/chantiers/${refusedAhead[0].worksite.id}` })
  const unstaffed = startingSoon.filter(w => w._count.assignments === 0)
  if (unstaffed.length) alerts.push({ id: "unstaffed", level: "urgent", title: `${plural(unstaffed.length, "chantier démarre", "chantiers démarrent")} sous 7 jours sans équipe`, detail: list(unstaffed.map(w => `${w.name} (${w.startDate?.toISOString().slice(0, 10)})`)), href: `/chantiers/${unstaffed[0].id}` })
  if (pendingSoon.length) alerts.push({ id: "pending", level: "attention", title: `${plural(pendingSoon.length, "affectation non confirmée", "affectations non confirmées")} pour aujourd'hui ou demain`, detail: `En attente du chef d'équipe : ${list([...new Set(pendingSoon.map(p => p.team.name))])}.`, href: "/planning" })
  if (overrun.length) alerts.push({ id: "overrun", level: "attention", title: `${plural(overrun.length, "chantier a dépassé", "chantiers ont dépassé")} sa date de fin`, detail: `À clôturer ou prolonger : ${list(overrun.map(w => w.name))}.`, href: `/chantiers/${overrun[0].id}` })
  if (absencesToValidate) alerts.push({ id: "absences", level: "attention", title: `${plural(absencesToValidate, "demande d'absence", "demandes d'absence")} à valider`, detail: "Les employés attendent votre réponse.", href: "/absences" })
  if (dueSoon.length) alerts.push({ id: "due-soon", level: "info", title: `${plural(dueSoon.length, "facture arrive", "factures arrivent")} à échéance sous 7 jours`, detail: `${eur(sum(dueSoon))} TTC attendus.`, href: "/factures" })
  const low = stock.filter(s => s.minQuantityMilli !== null && s.quantityMilli < s.minQuantityMilli).length
  if (low) alerts.push({ id: "stock", level: "info", title: `${plural(low, "article", "articles")} sous le seuil de stock`, detail: "Pensez à réapprovisionner.", href: "/stock" })
  if (drafts) alerts.push({ id: "consultations", level: "info", title: `${plural(drafts, "consultation", "consultations")} à traiter`, detail: "Demandes clients reçues par courriel, en attente de revue.", href: "/consultations" })
  alerts.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])

  return {
    date: today.toISOString().slice(0, 10),
    today: {
      worksites: [...byWorksite.values()],
      freeTeams: teams.filter(t => !busy.has(t.id)).map(t => t.name),
      absent: absentToday.map(a => `${a.employee.firstName} ${a.employee.lastName}`.trim()),
    },
    alerts,
  }
}

/** Nombre d'alertes qui méritent la pastille du menu (urgentes et à surveiller). */
export function badgeCount(b: Briefing): number {
  return b.alerts.filter(a => a.level !== "info").length
}
