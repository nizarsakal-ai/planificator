/**
 * Veille prospection — collecte quotidienne : sources → dédoublonnage → score → enregistrement par société.
 *
 * Chaque source est isolée : l'échec de l'une n'empêche pas les autres. La liste des festivals change rarement :
 * elle n'est relue que le lundi, ou tant qu'aucune fiche festival n'existe pour la société.
 * Les fiches « Masqué » des festivals ne sont pas enregistrées (des milliers de lignes sans intérêt) ;
 * celles du BOAMP le sont, pour l'audit et le réglage du score.
 * Aucun envoi, aucun changement de statut : la suite appartient à l'humain.
 */
import { awardedToByTenderId, dedupeCandidates } from "@/lib/prospection/dedup"
import type { ProspectionRepositoryPort, UpsertSummary } from "@/lib/prospection/prospection.repository"
import type { ProspectCandidate, ProspectSource, ScoredCandidate } from "@/lib/prospection/prospection.types"
import { scoreCandidate } from "@/lib/prospection/scoring"

export type SourceRunStatus = "OK" | "FAILED" | "DISABLED" | "NOT_DUE"

export interface SourceRunResult {
  source: ProspectSource
  status: SourceRunStatus
  fetched: number
  error?: string
}

export interface CompanyRunResult {
  companyId: string
  kept: number
  upsert: UpsertSummary
  awardsLinked: number
}

export interface ProspectionWatchRunResult {
  sources: SourceRunResult[]
  companies: CompanyRunResult[]
}

export interface ProspectionWatchDeps {
  companyIds: readonly string[]
  now: Date
  repository: ProspectionRepositoryPort
  fetchBoamp: () => Promise<ProspectCandidate[]>
  fetchFestivals: () => Promise<ProspectCandidate[]>
  /** `null` : adaptateur désactivé (pas de flux configuré). */
  fetchDatatourisme: (() => Promise<ProspectCandidate[]>) | null
  log?: (event: string, payload?: Record<string, unknown>) => void
}

const STORED_EVENT_BANDS = new Set(["A_TRAITER", "A_VERIFIER"])

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN_ERROR"
}

async function runSource(
  source: ProspectSource,
  fetcher: (() => Promise<ProspectCandidate[]>) | null,
  due: boolean,
): Promise<{ result: SourceRunResult; candidates: ProspectCandidate[] }> {
  if (!fetcher) return { result: { source, status: "DISABLED", fetched: 0 }, candidates: [] }
  if (!due) return { result: { source, status: "NOT_DUE", fetched: 0 }, candidates: [] }
  try {
    const candidates = await fetcher()
    return { result: { source, status: "OK", fetched: candidates.length }, candidates }
  } catch (error) {
    return { result: { source, status: "FAILED", fetched: 0, error: errorCode(error) }, candidates: [] }
  }
}

export function scoreAndDedupe(candidates: readonly ProspectCandidate[], now: Date): ScoredCandidate[] {
  return dedupeCandidates(candidates).map((candidate) => ({ ...candidate, ...scoreCandidate(candidate, now) }))
}

export function keepForStorage(candidate: ScoredCandidate): boolean {
  return candidate.kind !== "EVENT" || STORED_EVENT_BANDS.has(candidate.band)
}

export async function runProspectionWatch(deps: ProspectionWatchDeps): Promise<ProspectionWatchRunResult> {
  const log = deps.log ?? (() => undefined)
  if (deps.companyIds.length === 0) {
    log("no-company")
    return { sources: [], companies: [] }
  }

  const isMonday = deps.now.getUTCDay() === 1
  let festivalsDue = isMonday
  if (!festivalsDue) {
    for (const companyId of deps.companyIds) {
      if ((await deps.repository.countBySource(companyId, "FESTIVALS_CULTURE")) === 0) festivalsDue = true
    }
  }

  const runs = await Promise.all([
    runSource("BOAMP", deps.fetchBoamp, true),
    runSource("FESTIVALS_CULTURE", deps.fetchFestivals, festivalsDue),
    runSource("DATATOURISME", deps.fetchDatatourisme, true),
  ])
  for (const { result } of runs) log("source", { ...result })

  const scored = scoreAndDedupe(runs.flatMap((run) => run.candidates), deps.now).filter(keepForStorage)
  const awards = awardedToByTenderId(scored)

  const companies: CompanyRunResult[] = []
  for (const companyId of deps.companyIds) {
    const upsert = await deps.repository.upsertCandidates(companyId, scored, deps.now)
    const awardsLinked = await deps.repository.applyAwards(companyId, awards)
    companies.push({ companyId, kept: scored.length, upsert, awardsLinked })
    log("company", { companyId, kept: scored.length, ...upsert, awardsLinked })
  }

  return { sources: runs.map((run) => run.result), companies }
}
