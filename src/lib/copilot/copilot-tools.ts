/**
 * IA-1 : outils du copilote, EN LECTURE SEULE. Chaque outil reçoit le `companyId` de la session (jamais du modèle),
 * filtre toutes ses requêtes sur cette société, borne le nombre de lignes et renvoie des faits courts avec un lien
 * interne. Aucun outil n'écrit, n'envoie ni ne supprime quoi que ce soit.
 */
import type { PrismaClient, Prisma } from "@prisma/client"
import type Anthropic from "@anthropic-ai/sdk"
import { buildBriefing } from "@/lib/copilot/copilot-briefing"

type Db = Pick<PrismaClient, "assignment" | "worksite" | "invoice" | "absence" | "stockLevel" | "client" | "worksiteImportDraft" | "team" | "employee" | "article">

export const MAX_ROWS = 40
const MAX_RANGE_DAYS = 62
const DAY_MS = 86_400_000

export class CopilotToolInputError extends Error {}

/** Jour civil « AAAA-MM-JJ » strict → minuit UTC. */
export function parseDay(value: unknown, field: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CopilotToolInputError(`${field} : date AAAA-MM-JJ attendue.`)
  const d = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new CopilotToolInputError(`${field} : date invalide.`)
  return d
}

export function parseRange(input: Record<string, unknown>): { from: Date; to: Date } {
  const from = parseDay(input.debut, "debut")
  const to = parseDay(input.fin, "fin")
  if (to < from) throw new CopilotToolInputError("fin doit être postérieure ou égale à debut.")
  if ((to.getTime() - from.getTime()) / DAY_MS > MAX_RANGE_DAYS) throw new CopilotToolInputError(`Période limitée à ${MAX_RANGE_DAYS} jours.`)
  return { from, to }
}

const text = (value: unknown, max = 80): string | undefined => {
  if (typeof value !== "string") return undefined
  const t = value.trim().slice(0, max)
  return t || undefined
}
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const euros = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Math.round(Number(v) * 100) / 100)
const name = (e: { firstName: string; lastName: string } | null | undefined) => (e ? `${e.firstName} ${e.lastName}`.trim() : null)

const WORKSITE_STATUS = ["PLANNED", "IN_PROGRESS", "COMPLETED", "ARCHIVED", "EXTENDED", "DELAYED"] as const
const ABSENCE_STATUS = ["PENDING", "APPROVED", "REJECTED"] as const

export const COPILOT_TOOLS: Anthropic.Tool[] = [
  {
    name: "planning_periode",
    description: "Affectations équipe → chantier sur une période (jours inclus) : date, équipe, chantier, statut de confirmation.",
    input_schema: { type: "object", properties: { debut: { type: "string", description: "AAAA-MM-JJ" }, fin: { type: "string", description: "AAAA-MM-JJ" } }, required: ["debut", "fin"] },
  },
  {
    name: "disponibilites_jour",
    description: "Pour un jour donné : équipes actives sans affectation et employés absents (absences validées ou en attente).",
    input_schema: { type: "object", properties: { date: { type: "string", description: "AAAA-MM-JJ" } }, required: ["date"] },
  },
  {
    name: "chercher_chantiers",
    description: "Recherche de chantiers par texte (nom, adresse, client) et/ou statut. Sans critère : chantiers en cours et à venir.",
    input_schema: {
      type: "object",
      properties: {
        texte: { type: "string" },
        statut: { type: "string", enum: [...WORKSITE_STATUS] },
      },
    },
  },
  {
    name: "detail_chantier",
    description: "Fiche d'un chantier par identifiant : client, dates, statut, prochaines affectations, factures liées.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "factures",
    description: "Factures de vente. filtre = impayees (émises non soldées), en_retard (échéance dépassée), brouillons, payees. Renvoie aussi les totaux TTC.",
    input_schema: { type: "object", properties: { filtre: { type: "string", enum: ["impayees", "en_retard", "brouillons", "payees"] }, client: { type: "string" } }, required: ["filtre"] },
  },
  {
    name: "absences_periode",
    description: "Absences des employés qui chevauchent une période (jours inclus), avec type et statut.",
    input_schema: {
      type: "object",
      properties: { debut: { type: "string" }, fin: { type: "string" }, statut: { type: "string", enum: [...ABSENCE_STATUS] } },
      required: ["debut", "fin"],
    },
  },
  {
    name: "stock_bas",
    description: "Articles dont le stock est sous le seuil minimal, par entrepôt.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "chercher_clients",
    description: "Recherche de clients par nom, avec le nombre de chantiers et le montant TTC restant à encaisser.",
    input_schema: { type: "object", properties: { texte: { type: "string" } }, required: ["texte"] },
  },
  {
    name: "consultations_recentes",
    description: "Dernières consultations reçues (demandes clients importées des courriels) : client, chantier proposé, dates, statut.",
    input_schema: { type: "object", properties: { a_traiter: { type: "boolean", description: "true = seulement celles en attente de revue" } } },
  },
  {
    name: "equipes",
    description: "Équipes actives (identifiant, nom, chef d'équipe) et nombre d'employés actifs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "briefing_du_jour",
    description: "Briefing du jour : chantiers et équipes d'aujourd'hui, équipes libres, absents, et alertes de veille classées par urgence (factures en retard, affectations refusées ou non confirmées, chantiers sans équipe, dépassements, absences à valider, stock bas, consultations).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "chercher_employes",
    description: "Employés actifs par nom ou prénom (identifiant, nom, poste). Sans texte : les 40 premiers.",
    input_schema: { type: "object", properties: { texte: { type: "string" } } },
  },
  {
    name: "chercher_articles",
    description: "Articles actifs du catalogue (identifiant, désignation, unité, prix HT, TVA) par texte.",
    input_schema: { type: "object", properties: { texte: { type: "string" } }, required: ["texte"] },
  },
]

export const COPILOT_TOOL_NAMES = new Set(COPILOT_TOOLS.map(t => t.name))

type Handler = (db: Db, companyId: string, input: Record<string, unknown>, today: Date) => Promise<unknown>

const handlers: Record<string, Handler> = {
  async planning_periode(db, companyId, input) {
    const { from, to } = parseRange(input)
    const rows = await db.assignment.findMany({
      where: { date: { gte: from, lte: to }, worksite: { companyId } },
      orderBy: [{ date: "asc" }],
      take: MAX_ROWS * 3,
      select: { date: true, status: true, team: { select: { name: true } }, worksite: { select: { id: true, name: true } } },
    })
    return {
      affectations: rows.map(r => ({ date: day(r.date), equipe: r.team.name, chantier: r.worksite.name, statut: r.status, lien: `/chantiers/${r.worksite.id}` })),
      tronque: rows.length === MAX_ROWS * 3,
    }
  },

  async disponibilites_jour(db, companyId, input) {
    const date = parseDay(input.date, "date")
    const [teams, busy, absences] = await Promise.all([
      db.team.findMany({ where: { companyId, active: true }, select: { id: true, name: true }, take: 100 }),
      db.assignment.findMany({ where: { date, worksite: { companyId } }, select: { teamId: true, worksite: { select: { name: true } } } }),
      db.absence.findMany({
        where: { companyId, status: { in: ["APPROVED", "PENDING"] }, startDate: { lte: date }, endDate: { gte: date } },
        select: { type: true, status: true, employee: { select: { firstName: true, lastName: true } } },
        take: MAX_ROWS,
      }),
    ])
    const busyIds = new Set(busy.map(b => b.teamId))
    return {
      date: day(date),
      equipes_libres: teams.filter(t => !busyIds.has(t.id)).map(t => t.name),
      equipes_occupees: teams.filter(t => busyIds.has(t.id)).map(t => t.name),
      absents: absences.map(a => ({ employe: name(a.employee), type: a.type, statut: a.status })),
    }
  },

  async chercher_chantiers(db, companyId, input) {
    const q = text(input.texte)
    const status = WORKSITE_STATUS.find(s => s === input.statut)
    const where: Prisma.WorksiteWhereInput = { companyId }
    if (status) where.status = status
    else if (!q) where.status = { in: ["PLANNED", "IN_PROGRESS", "EXTENDED", "DELAYED"] }
    if (q) where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { address: { contains: q, mode: "insensitive" } },
      { client: { name: { contains: q, mode: "insensitive" } } },
    ]
    const rows = await db.worksite.findMany({
      where, take: MAX_ROWS, orderBy: [{ startDate: "asc" }],
      select: { id: true, name: true, status: true, startDate: true, endDate: true, address: true, client: { select: { name: true } } },
    })
    return rows.map(w => ({ id: w.id, nom: w.name, client: w.client.name, statut: w.status, debut: day(w.startDate), fin: day(w.endDate), adresse: w.address, lien: `/chantiers/${w.id}` }))
  },

  async detail_chantier(db, companyId, input, today) {
    const id = text(input.id, 40)
    if (!id) throw new CopilotToolInputError("id obligatoire.")
    const w = await db.worksite.findFirst({
      where: { id, companyId },
      select: { id: true, name: true, status: true, startDate: true, endDate: true, address: true, description: true, dailyHours: true, client: { select: { name: true } } },
    })
    if (!w) return { introuvable: true }
    const [next, invoices] = await Promise.all([
      db.assignment.findMany({
        where: { worksiteId: w.id, date: { gte: today } }, orderBy: { date: "asc" }, take: 20,
        select: { date: true, status: true, team: { select: { name: true } } },
      }),
      db.invoice.findMany({
        where: { worksiteId: w.id, companyId }, take: 20, orderBy: { issueDate: "desc" },
        select: { id: true, number: true, status: true, kind: true, totalTTC: true, dueDate: true },
      }),
    ])
    return {
      nom: w.name, client: w.client.name, statut: w.status, debut: day(w.startDate), fin: day(w.endDate), adresse: w.address,
      description: w.description?.slice(0, 500) ?? null, heures_par_jour: w.dailyHours, lien: `/chantiers/${w.id}`,
      prochaines_affectations: next.map(a => ({ date: day(a.date), equipe: a.team.name, statut: a.status })),
      factures: invoices.map(i => ({ numero: i.number, statut: i.status, type: i.kind, ttc: euros(i.totalTTC), echeance: day(i.dueDate), lien: `/factures/${i.id}` })),
    }
  },

  async factures(db, companyId, input, today) {
    const where: Prisma.InvoiceWhereInput = { companyId, kind: "INVOICE" }
    switch (input.filtre) {
      case "impayees": where.status = { in: ["SENT", "PARTIAL"] }; break
      case "en_retard": where.status = { in: ["SENT", "PARTIAL"] }; where.dueDate = { lt: today }; break
      case "brouillons": where.status = "DRAFT"; break
      case "payees": where.status = "PAID"; break
      default: throw new CopilotToolInputError("filtre invalide.")
    }
    const client = text(input.client)
    if (client) where.client = { name: { contains: client, mode: "insensitive" } }
    const [rows, agg] = await Promise.all([
      db.invoice.findMany({
        where, take: MAX_ROWS, orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
        select: { id: true, number: true, status: true, totalTTC: true, issueDate: true, dueDate: true, client: { select: { name: true } }, worksite: { select: { name: true } } },
      }),
      db.invoice.aggregate({ where, _sum: { totalTTC: true }, _count: true }),
    ])
    return {
      nombre: agg._count, total_ttc: euros(agg._sum.totalTTC),
      note: input.filtre === "impayees" || input.filtre === "en_retard" ? "Totaux TTC des factures ; les acomptes partiels déjà reçus ne sont pas déduits." : undefined,
      factures: rows.map(i => ({
        numero: i.number, client: i.client.name, chantier: i.worksite.name, statut: i.status, ttc: euros(i.totalTTC),
        emise: day(i.issueDate), echeance: day(i.dueDate),
        jours_de_retard: i.dueDate && i.dueDate < today ? Math.floor((today.getTime() - i.dueDate.getTime()) / DAY_MS) : 0,
        lien: `/factures/${i.id}`,
      })),
    }
  },

  async absences_periode(db, companyId, input) {
    const { from, to } = parseRange(input)
    const status = ABSENCE_STATUS.find(s => s === input.statut)
    const rows = await db.absence.findMany({
      where: { companyId, startDate: { lte: to }, endDate: { gte: from }, ...(status ? { status } : {}) },
      orderBy: { startDate: "asc" }, take: MAX_ROWS,
      select: { type: true, status: true, startDate: true, endDate: true, employee: { select: { firstName: true, lastName: true } } },
    })
    return rows.map(a => ({ employe: name(a.employee), type: a.type, statut: a.status, debut: day(a.startDate), fin: day(a.endDate), lien: "/absences" }))
  },

  async stock_bas(db, companyId) {
    const rows = await db.stockLevel.findMany({
      where: { companyId, minQuantityMilli: { gt: 0 } }, take: 500,
      select: { quantityMilli: true, minQuantityMilli: true, article: { select: { designation: true, unit: true } }, warehouse: { select: { name: true } } },
    })
    return rows
      .filter(r => r.minQuantityMilli !== null && r.quantityMilli < r.minQuantityMilli)
      .slice(0, MAX_ROWS)
      .map(r => ({ article: r.article.designation, entrepot: r.warehouse.name, quantite: r.quantityMilli / 1000, seuil: (r.minQuantityMilli ?? 0) / 1000, unite: r.article.unit, lien: "/stock" }))
  },

  async chercher_clients(db, companyId, input) {
    const q = text(input.texte)
    if (!q) throw new CopilotToolInputError("texte obligatoire.")
    const clients = await db.client.findMany({
      where: { companyId, name: { contains: q, mode: "insensitive" } }, take: 15,
      select: { id: true, name: true, active: true, _count: { select: { worksites: true } } },
    })
    const due = await Promise.all(clients.map(c => db.invoice.aggregate({
      where: { companyId, clientId: c.id, kind: "INVOICE", status: { in: ["SENT", "PARTIAL"] } }, _sum: { totalTTC: true }, _count: true,
    })))
    return clients.map((c, i) => ({
      nom: c.name, actif: c.active, chantiers: c._count.worksites,
      factures_impayees: due[i]._count, ttc_impaye: euros(due[i]._sum.totalTTC), lien: "/clients",
    }))
  },

  async consultations_recentes(db, companyId, input) {
    const rows = await db.worksiteImportDraft.findMany({
      where: { companyId, ...(input.a_traiter === true ? { status: "PENDING_REVIEW" } : {}) },
      orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, status: true, proposedClientName: true, proposedWorksiteName: true, proposedCity: true, proposedStartDate: true, proposedEndDate: true, createdAt: true },
    })
    return rows.map(d => ({
      client: d.proposedClientName, chantier: d.proposedWorksiteName, ville: d.proposedCity, statut: d.status,
      debut: day(d.proposedStartDate), fin: day(d.proposedEndDate), recue: day(d.createdAt), lien: `/consultations/${d.id}`,
    }))
  },

  async equipes(db, companyId) {
    const [teams, employees] = await Promise.all([
      db.team.findMany({ where: { companyId, active: true }, take: 100, orderBy: { name: "asc" }, select: { id: true, name: true, leader: { select: { firstName: true, lastName: true } } } }),
      db.employee.count({ where: { companyId, active: true } }),
    ])
    return { equipes: teams.map(t => ({ id: t.id, nom: t.name, chef: name(t.leader) })), employes_actifs: employees, lien: "/equipes" }
  },

  async briefing_du_jour(db, companyId, _input, today) {
    const b = await buildBriefing(db, companyId, today)
    return { ...b, alerts: b.alerts.map(a => ({ urgence: a.level, titre: a.title, detail: a.detail, lien: a.href })) }
  },

  async chercher_employes(db, companyId, input) {
    const q = text(input.texte)
    const rows = await db.employee.findMany({
      where: { companyId, active: true, ...(q ? { OR: [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }] } : {}) },
      take: MAX_ROWS, orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true, jobTitle: true, role: true },
    })
    return rows.map(e => ({ id: e.id, nom: name(e), poste: e.jobTitle, role: e.role }))
  },

  async chercher_articles(db, companyId, input) {
    const q = text(input.texte)
    if (!q) throw new CopilotToolInputError("texte obligatoire.")
    const rows = await db.article.findMany({
      where: { companyId, active: true, OR: [{ designation: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] },
      take: 20, orderBy: { designation: "asc" },
      select: { id: true, reference: true, designation: true, unit: true, unitPrice: true, vatRate: true },
    })
    return rows.map(a => ({ id: a.id, reference: a.reference, designation: a.designation, unite: a.unit, prix_ht: euros(a.unitPrice), tva: Number(a.vatRate), lien: "/articles" }))
  },
}

/** Exécute un outil ; erreurs d'entrée renvoyées au modèle, autres erreurs remontées (journalisées sans contenu). */
export async function runCopilotTool(db: Db, companyId: string, toolName: string, input: unknown, today: Date): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const handler = handlers[toolName]
  if (!handler || !companyId) return { ok: false, error: "Outil inconnu." }
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  try {
    return { ok: true, result: await handler(db, companyId, args, today) }
  } catch (error) {
    if (error instanceof CopilotToolInputError) return { ok: false, error: error.message }
    throw error
  }
}
