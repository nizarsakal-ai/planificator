/**
 * IA-2 : outils de PROPOSITION du copilote. Ils ne modifient rien : ils vérifient les références dans la société de la
 * session, détectent les conflits évidents et renvoient une carte signée à confirmer par l'utilisateur.
 * L'exécution réelle (copilot-execute.ts) repasse par les fonctions de l'interface, qui refont tous leurs contrôles.
 */
import type { PrismaClient, Prisma } from "@prisma/client"
import type Anthropic from "@anthropic-ai/sdk"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { CopilotToolInputError, parseDay } from "@/lib/copilot/copilot-tools"
import { signProposal, type ProposalCard, type ProposalPayload, type QuoteLinePayload } from "@/lib/copilot/copilot-proposal"

type Db = Pick<PrismaClient, "worksite" | "team" | "employee" | "assignment" | "article">

export interface ActionContext { companyId: string; userId: string; secret: string; billingEnabled: boolean; today: Date }

const DAY_MS = 86_400_000
const MAX_ASSIGN_DAYS = 62
const MAX_QUOTE_LINES = 30

export const COPILOT_ACTION_TOOLS: Anthropic.Tool[] = [
  {
    name: "proposer_tache",
    description: "Prépare la création d'une tâche interne. Rien n'est créé : l'utilisateur verra une carte et devra cliquer « Je confirme ». Identifiants de chantier et d'employé obtenus par les outils de recherche.",
    input_schema: {
      type: "object",
      properties: {
        titre: { type: "string", description: "3 à 200 caractères" },
        description: { type: "string" },
        echeance: { type: "string", description: "AAAA-MM-JJ" },
        priorite: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        chantier_id: { type: "string" },
        employe_id: { type: "string", description: "Responsable (identifiant d'employé)" },
      },
      required: ["titre"],
    },
  },
  {
    name: "proposer_affectation",
    description: "Prépare l'affectation d'une équipe à un chantier du jour debut au jour fin inclus. Rien n'est créé avant la confirmation de l'utilisateur. Refusé si l'équipe est déjà prise ces jours-là.",
    input_schema: {
      type: "object",
      properties: {
        chantier_id: { type: "string" },
        equipe_id: { type: "string" },
        debut: { type: "string", description: "AAAA-MM-JJ" },
        fin: { type: "string", description: "AAAA-MM-JJ, par défaut = debut" },
      },
      required: ["chantier_id", "equipe_id", "debut"],
    },
  },
  {
    name: "proposer_devis",
    description: "Prépare un BROUILLON de devis pour un chantier (jamais envoyé). Pour chaque ligne, donne article_id (prix, unité et TVA du catalogue) ou bien designation + prix_unitaire_ht. Rien n'est créé avant la confirmation.",
    input_schema: {
      type: "object",
      properties: {
        chantier_id: { type: "string" },
        objet: { type: "string" },
        lignes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              article_id: { type: "string" },
              designation: { type: "string" },
              quantite: { type: "number" },
              prix_unitaire_ht: { type: "number", description: "euros HT, si pas d'article" },
              tva: { type: "number", description: "taux en %, 20 par défaut" },
            },
            required: ["quantite"],
          },
        },
      },
      required: ["chantier_id", "lignes"],
    },
  },
]

export const COPILOT_ACTION_TOOL_NAMES = new Set(COPILOT_ACTION_TOOLS.map(t => t.name))

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null
  const t = v.trim().slice(0, max)
  return t || null
}
const id = (v: unknown, field: string): string => {
  const t = str(v, 64)
  if (!t) throw new CopilotToolInputError(`${field} obligatoire.`)
  return t
}
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
const euros = (cents: bigint) => (Number(cents) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })
const PRIORITY_LABEL = { LOW: "Basse", MEDIUM: "Moyenne", HIGH: "Haute" } as const

type Prepared = { card: Omit<ProposalCard, "token">; payload: ProposalPayload }
type Preparer = (db: Db, input: Record<string, unknown>, ctx: ActionContext) => Promise<Prepared>

const preparers: Record<string, Preparer> = {
  async proposer_tache(db, input, ctx) {
    const title = str(input.titre, 200)
    if (!title || title.length < 3) throw new CopilotToolInputError("titre : 3 à 200 caractères.")
    const description = str(input.description, 2000)
    const priority = input.priorite === "LOW" || input.priorite === "HIGH" ? input.priorite : "MEDIUM"
    const dueDate = input.echeance === undefined || input.echeance === null || input.echeance === "" ? null : parseDay(input.echeance, "echeance").toISOString().slice(0, 10)
    const details = [`Titre : ${title}`, `Priorité : ${PRIORITY_LABEL[priority]}`]
    if (dueDate) details.push(`Échéance : ${fmtDay(dueDate)}`)
    let worksiteId: string | null = null
    if (input.chantier_id) {
      const w = await db.worksite.findFirst({ where: { id: id(input.chantier_id, "chantier_id"), companyId: ctx.companyId }, select: { id: true, name: true } })
      if (!w) throw new CopilotToolInputError("Chantier introuvable dans cette société.")
      worksiteId = w.id
      details.push(`Chantier : ${w.name}`)
    }
    let assigneeId: string | null = null
    if (input.employe_id) {
      const e = await db.employee.findFirst({ where: { id: id(input.employe_id, "employe_id"), companyId: ctx.companyId, active: true }, select: { id: true, firstName: true, lastName: true } })
      if (!e) throw new CopilotToolInputError("Employé introuvable ou inactif dans cette société.")
      assigneeId = e.id
      details.push(`Responsable : ${e.firstName} ${e.lastName}`)
    }
    if (description) details.push(`Description : ${description.slice(0, 300)}`)
    return { card: { kind: "TASK", title: "Créer une tâche", details }, payload: { kind: "TASK", data: { title, description, priority, dueDate, assigneeId, worksiteId } } }
  },

  async proposer_affectation(db, input, ctx) {
    const from = parseDay(input.debut, "debut")
    const to = input.fin ? parseDay(input.fin, "fin") : from
    if (to < from) throw new CopilotToolInputError("fin doit être postérieure ou égale à debut.")
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1
    if (days > MAX_ASSIGN_DAYS) throw new CopilotToolInputError(`Affectation limitée à ${MAX_ASSIGN_DAYS} jours.`)
    if (from < ctx.today) throw new CopilotToolInputError("Impossible d'affecter une équipe dans le passé.")
    const [w, t] = await Promise.all([
      db.worksite.findFirst({ where: { id: id(input.chantier_id, "chantier_id"), companyId: ctx.companyId }, select: { id: true, name: true, status: true } }),
      db.team.findFirst({ where: { id: id(input.equipe_id, "equipe_id"), companyId: ctx.companyId, active: true }, select: { id: true, name: true } }),
    ])
    if (!w) throw new CopilotToolInputError("Chantier introuvable dans cette société.")
    if (!t) throw new CopilotToolInputError("Équipe introuvable ou inactive dans cette société.")
    if (w.status === "COMPLETED" || w.status === "ARCHIVED") throw new CopilotToolInputError("Ce chantier est terminé ou archivé.")
    const conflict = await db.assignment.findFirst({
      where: { teamId: t.id, date: { gte: from, lte: to }, worksite: { companyId: ctx.companyId } },
      orderBy: { date: "asc" }, select: { date: true, worksite: { select: { name: true } } },
    })
    if (conflict) throw new CopilotToolInputError(`L'équipe ${t.name} est déjà affectée au chantier ${conflict.worksite.name} le ${conflict.date.toISOString().slice(0, 10)}.`)
    const dateFrom = from.toISOString().slice(0, 10)
    const dateTo = to.toISOString().slice(0, 10)
    const details = [`Équipe : ${t.name}`, `Chantier : ${w.name}`, days === 1 ? `Jour : ${fmtDay(dateFrom)}` : `Du ${fmtDay(dateFrom)} au ${fmtDay(dateTo)} (${days} jours)`]
    return {
      card: { kind: "ASSIGNMENT", title: "Affecter une équipe", details, warning: "Le chef d'équipe recevra une notification et un courriel, comme pour une affectation faite à la main." },
      payload: { kind: "ASSIGNMENT", data: { worksiteId: w.id, teamId: t.id, dateFrom, dateTo } },
    }
  },

  async proposer_devis(db, input, ctx) {
    if (!ctx.billingEnabled) throw new CopilotToolInputError("Le module Devis n'est pas activé.")
    const w = await db.worksite.findFirst({ where: { id: id(input.chantier_id, "chantier_id"), companyId: ctx.companyId }, select: { id: true, name: true, client: { select: { name: true } } } })
    if (!w) throw new CopilotToolInputError("Chantier introuvable dans cette société.")
    const raw = Array.isArray(input.lignes) ? input.lignes.slice(0, MAX_QUOTE_LINES + 1) : []
    if (raw.length === 0) throw new CopilotToolInputError("Au moins une ligne.")
    if (raw.length > MAX_QUOTE_LINES) throw new CopilotToolInputError(`${MAX_QUOTE_LINES} lignes au plus.`)
    const articleIds = raw.flatMap(l => (typeof (l as { article_id?: unknown })?.article_id === "string" ? [(l as { article_id: string }).article_id.slice(0, 64)] : []))
    const articles = articleIds.length
      ? await db.article.findMany({ where: { id: { in: articleIds }, companyId: ctx.companyId, active: true }, select: { id: true, designation: true, unit: true, unitPrice: true, vatRate: true } })
      : []
    const byId = new Map(articles.map(a => [a.id, a]))
    const lines: QuoteLinePayload[] = raw.map((l, i) => {
      const line = (l ?? {}) as Record<string, unknown>
      const quantity = Number(line.quantite)
      if (!Number.isFinite(quantity) || quantity <= 0) throw new CopilotToolInputError(`Ligne ${i + 1} : quantité invalide.`)
      const qty = String(Math.round(quantity * 100) / 100)
      if (typeof line.article_id === "string") {
        const a = byId.get(line.article_id.slice(0, 64))
        if (!a) throw new CopilotToolInputError(`Ligne ${i + 1} : article introuvable ou inactif.`)
        return { articleId: a.id, designation: a.designation, unit: a.unit, quantity: qty, unitPrice: (a.unitPrice as Prisma.Decimal).toFixed(2), vatRate: (a.vatRate as Prisma.Decimal).toString() }
      }
      const designation = str(line.designation, 200)
      const price = Number(line.prix_unitaire_ht)
      if (!designation) throw new CopilotToolInputError(`Ligne ${i + 1} : designation ou article_id obligatoire.`)
      if (!Number.isFinite(price) || price < 0) throw new CopilotToolInputError(`Ligne ${i + 1} : prix_unitaire_ht obligatoire sans article.`)
      const vat = line.tva === undefined ? 20 : Number(line.tva)
      return { articleId: null, designation, unit: "u", quantity: qty, unitPrice: price.toFixed(2), vatRate: String(vat) }
    })
    const issueDate = ctx.today.toISOString().slice(0, 10)
    const subject = str(input.objet, 200)
    // Même validation que le formulaire de devis : montants, taux de TVA autorisés, totaux.
    const parsed = parseQuoteForm({ worksiteId: w.id, issueDate, subject: subject ?? "", lines: lines.map(l => ({ ...l, articleId: l.articleId })) })
    if (!parsed.ok) throw new CopilotToolInputError(parsed.error)
    const t = parsed.value.totals
    const details = [
      `Client : ${w.client.name}`, `Chantier : ${w.name}`, ...(subject ? [`Objet : ${subject}`] : []),
      ...lines.slice(0, 8).map(l => `• ${l.quantity} ${l.unit} × ${l.designation} à ${Number(l.unitPrice).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })} HT`),
      ...(lines.length > 8 ? [`… et ${lines.length - 8} autre(s) ligne(s)`] : []),
      `Total : ${euros(t.totalHTCents)} HT · ${euros(t.totalTTCCents)} TTC`,
    ]
    return {
      card: { kind: "QUOTE", title: "Créer un brouillon de devis", details, warning: "Brouillon seulement : rien n'est envoyé au client." },
      payload: { kind: "QUOTE", data: { worksiteId: w.id, issueDate, subject, lines } },
    }
  },
}

/** Prépare une proposition : erreurs d'entrée renvoyées au modèle ; carte signée sinon. */
export async function prepareCopilotAction(db: Db, toolName: string, input: unknown, ctx: ActionContext): Promise<{ ok: true; card: ProposalCard } | { ok: false; error: string }> {
  const preparer = preparers[toolName]
  if (!preparer || !ctx.companyId || !ctx.userId) return { ok: false, error: "Outil inconnu." }
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  try {
    const { card, payload } = await preparer(db, args, ctx)
    return { ok: true, card: { ...card, token: signProposal(payload, { companyId: ctx.companyId, userId: ctx.userId }, ctx.secret) } }
  } catch (error) {
    if (error instanceof CopilotToolInputError) return { ok: false, error: error.message }
    throw error
  }
}
