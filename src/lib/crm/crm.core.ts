/**
 * Lot E Planificator V2 : opportunités commerciales — règles PURES.
 *
 * Étapes ouvertes : piste (LEAD), qualifiée, proposition, négociation ; étapes closes : gagnée (probabilité 100 %),
 * perdue (probabilité 0 %, motif obligatoire). Une opportunité close est figée (la base le garantit). La probabilité
 * est proposée par étape et ajustable sur une étape ouverte. Montants en centimes, probabilités en points de base.
 * Pipeline pondéré = Σ montant × probabilité / 10 000, arrondi au centime le plus proche, sur les seules étapes ouvertes.
 */
export type OpportunityStage = "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION" | "WON" | "LOST"
export const STAGES: readonly OpportunityStage[] = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"]
export const OPEN_STAGES: readonly OpportunityStage[] = ["LEAD", "QUALIFIED", "PROPOSAL", "NEGOTIATION"]
export const STAGE_LABEL: Record<OpportunityStage, string> = {
  LEAD: "Piste", QUALIFIED: "Qualifiée", PROPOSAL: "Proposition", NEGOTIATION: "Négociation", WON: "Gagnée", LOST: "Perdue",
}
export const DEFAULT_PROBABILITY_BP: Record<OpportunityStage, number> = { LEAD: 1000, QUALIFIED: 2500, PROPOSAL: 5000, NEGOTIATION: 7500, WON: 10000, LOST: 0 }
export const MAX_CENTS = BigInt(10_000_000_000_000)
export const isOpen = (s: OpportunityStage) => (OPEN_STAGES as readonly string[]).includes(s)
export const isStage = (v: string): v is OpportunityStage => (STAGES as readonly string[]).includes(v)

export const CRM_ERRORS = {
  notFound: "Élément introuvable.",
  title: "Intitulé obligatoire (3 à 200 caractères).",
  party: "Choisissez un client ou saisissez le nom du prospect (2 à 200 caractères).",
  amount: "Montant invalide (positif, au plus 100 milliards d'euros).",
  probability: "Probabilité invalide (0 à 100 %).",
  stage: "Étape invalide.",
  closed: "Opportunité close (gagnée ou perdue) : elle n'est plus modifiable.",
  sameStage: "L'opportunité est déjà à cette étape.",
  lostReason: "Motif de perte obligatoire (3 à 500 caractères).",
  note: "Note obligatoire (3 à 2 000 caractères).",
  followUpNote: "Note de relance trop longue (1 000 caractères au plus).",
  date: "Date invalide.",
  quoteClient: "Le devis lié doit concerner le client de l'opportunité.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })
const okv = <T>(value: T): Plan<T> => ({ ok: true, value })
const clean = (v: string | null | undefined) => (v ?? "").trim()

export interface OpportunityFields {
  title: string; clientId?: string | null; prospectName?: string | null; amountCents: bigint
  probabilityBp?: number | null; expectedCloseDate?: Date | null; nextFollowUpDate?: Date | null; followUpNote?: string | null
}
/** Champs communs (création, mise à jour) ; la probabilité absente prend la valeur par défaut de l'étape. */
export function validateFields(f: OpportunityFields, stage: OpportunityStage): Plan<{
  title: string; clientId: string | null; prospectName: string | null; amountCents: bigint; probabilityBp: number
  expectedCloseDate: Date | null; nextFollowUpDate: Date | null; followUpNote: string | null
}> {
  const title = clean(f.title)
  if (title.length < 3 || title.length > 200) return ko(CRM_ERRORS.title)
  const clientId = clean(f.clientId) || null
  const prospectName = clean(f.prospectName) || null
  if (!clientId && (!prospectName || prospectName.length < 2)) return ko(CRM_ERRORS.party)
  if (prospectName && prospectName.length > 200) return ko(CRM_ERRORS.party)
  if (typeof f.amountCents !== "bigint" || f.amountCents < BigInt(0) || f.amountCents > MAX_CENTS) return ko(CRM_ERRORS.amount)
  const p = f.probabilityBp ?? DEFAULT_PROBABILITY_BP[stage]
  if (!Number.isSafeInteger(p) || p < 0 || p > 10000) return ko(CRM_ERRORS.probability)
  for (const d of [f.expectedCloseDate, f.nextFollowUpDate]) if (d && Number.isNaN(d.getTime())) return ko(CRM_ERRORS.date)
  const followUpNote = clean(f.followUpNote) || null
  if (followUpNote && followUpNote.length > 1000) return ko(CRM_ERRORS.followUpNote)
  return okv({ title, clientId, prospectName: clientId ? null : prospectName, amountCents: f.amountCents, probabilityBp: p, expectedCloseDate: f.expectedCloseDate ?? null, nextFollowUpDate: f.nextFollowUpDate ?? null, followUpNote })
}

/** Changement d'étape : depuis une étape ouverte seulement ; gagnée et perdue fixent la probabilité et la clôture. */
export function planStageChange(from: OpportunityStage, to: string, lostReason: string | null | undefined, now: Date): Plan<{
  stage: OpportunityStage; probabilityBp: number | null; closedAt: Date | null; lostReason: string | null
}> {
  if (!isOpen(from)) return ko(CRM_ERRORS.closed)
  if (!isStage(to)) return ko(CRM_ERRORS.stage)
  if (to === from) return ko(CRM_ERRORS.sameStage)
  if (to === "LOST") {
    const r = clean(lostReason)
    if (r.length < 3 || r.length > 500) return ko(CRM_ERRORS.lostReason)
    return okv({ stage: to, probabilityBp: 0, closedAt: now, lostReason: r })
  }
  if (to === "WON") return okv({ stage: to, probabilityBp: 10000, closedAt: now, lostReason: null })
  return okv({ stage: to, probabilityBp: DEFAULT_PROBABILITY_BP[to], closedAt: null, lostReason: null })
}

export function validateNote(raw: string | null | undefined): Plan<string> {
  const n = clean(raw)
  return n.length < 3 || n.length > 2000 ? ko(CRM_ERRORS.note) : okv(n)
}

/** Montant pondéré au centime le plus proche (moitié vers le haut). */
export const weightedCents = (amountCents: bigint, probabilityBp: number) => (amountCents * BigInt(probabilityBp) + BigInt(5000)) / BigInt(10000)

export interface PipelineRow { stage: OpportunityStage; count: number; amountCents: bigint; weightedCents: bigint }
export interface Pipeline { rows: PipelineRow[]; openCount: number; openAmountCents: bigint; openWeightedCents: bigint; followUpsDue: number }

/** Synthèse du pipeline ; « relance due » = étape ouverte et date de relance ≤ jour courant (Paris). */
export function computePipeline(items: readonly { stage: OpportunityStage; amountCents: bigint; probabilityBp: number; nextFollowUpDate: Date | null }[], today: Date): Pipeline {
  const rows = new Map<OpportunityStage, PipelineRow>(STAGES.map((s) => [s, { stage: s, count: 0, amountCents: BigInt(0), weightedCents: BigInt(0) }]))
  let followUpsDue = 0
  for (const o of items) {
    const r = rows.get(o.stage)!
    r.count++
    r.amountCents += o.amountCents
    r.weightedCents += weightedCents(o.amountCents, o.probabilityBp)
    if (isOpen(o.stage) && o.nextFollowUpDate && o.nextFollowUpDate.getTime() <= today.getTime()) followUpsDue++
  }
  const open = OPEN_STAGES.map((s) => rows.get(s)!)
  return {
    rows: STAGES.map((s) => rows.get(s)!),
    openCount: open.reduce((t, r) => t + r.count, 0),
    openAmountCents: open.reduce((t, r) => t + r.amountCents, BigInt(0)),
    openWeightedCents: open.reduce((t, r) => t + r.weightedCents, BigInt(0)),
    followUpsDue,
  }
}
