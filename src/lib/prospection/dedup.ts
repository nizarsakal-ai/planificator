/**
 * Veille prospection — dédoublonnage d'un lot de candidats.
 *
 * 1. Même source et même identifiant : la première occurrence l'emporte (les pages sont triées du plus récent
 *    au plus ancien) et les listes sont complétées par les suivantes.
 * 2. Sources différentes, même empreinte : une seule fiche, la source prioritaire (BOAMP, puis DATAtourisme, puis festivals)
 *    l'emporte et l'autre référence est notée dans `alsoSeenIn`.
 *
 * Empreinte : organisation + mots significatifs de l'intitulé + date limite pour un avis ;
 * intitulé + commune pour un événement.
 */
import type { ProspectCandidate, ProspectSource } from "@/lib/prospection/prospection.types"
import { normalizeText, significantWords } from "@/lib/prospection/text-normalize"

const SOURCE_PRIORITY: Readonly<Record<ProspectSource, number>> = { BOAMP: 0, DATATOURISME: 1, FESTIVALS_CULTURE: 2 }
const TITLE_WORDS_IN_FINGERPRINT = 12

export function fingerprintCandidate(candidate: ProspectCandidate): string {
  const title = significantWords(candidate.title).slice(0, TITLE_WORDS_IN_FINGERPRINT).join(" ")
  if (candidate.kind === "EVENT") return `event|${title}|${normalizeText(candidate.locality)}`
  const deadline = candidate.deadlineAt ? candidate.deadlineAt.toISOString().slice(0, 10) : ""
  return `${candidate.kind.toLowerCase()}|${normalizeText(candidate.organization)}|${title}|${deadline}`
}

export interface DedupedCandidate extends ProspectCandidate {
  fingerprint: string
  alsoSeenIn: string[]
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

function mergeSameSource(kept: DedupedCandidate, other: ProspectCandidate): DedupedCandidate {
  return {
    ...kept,
    organization: kept.organization ?? other.organization,
    deadlineAt: kept.deadlineAt ?? other.deadlineAt,
    departmentCodes: union(kept.departmentCodes, other.departmentCodes),
    winners: union(kept.winners, other.winners),
    linkedSourceIds: union(kept.linkedSourceIds, other.linkedSourceIds),
    descriptors: union(kept.descriptors, other.descriptors),
  }
}

export function dedupeCandidates(candidates: readonly ProspectCandidate[]): DedupedCandidate[] {
  const bySourceId = new Map<string, DedupedCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.sourceId}`
    const existing = bySourceId.get(key)
    bySourceId.set(
      key,
      existing ? mergeSameSource(existing, candidate) : { ...candidate, fingerprint: fingerprintCandidate(candidate), alsoSeenIn: [] },
    )
  }

  const ordered = [...bySourceId.values()].sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source])
  const byFingerprint = new Map<string, DedupedCandidate>()
  const result: DedupedCandidate[] = []
  for (const candidate of ordered) {
    const winner = byFingerprint.get(candidate.fingerprint)
    if (winner && winner.source !== candidate.source) {
      winner.alsoSeenIn = union(winner.alsoSeenIn, [`${candidate.source}:${candidate.sourceId}`])
      winner.departmentCodes = union(winner.departmentCodes, candidate.departmentCodes)
      winner.url = winner.url ?? candidate.url
      continue
    }
    if (!winner) byFingerprint.set(candidate.fingerprint, candidate)
    result.push(candidate)
  }
  return result
}

/**
 * Attributions → avis initial : identifiants d'appels d'offres BOAMP et titulaires qui les ont remportés
 * (sert à afficher « Attribué à … » sur la fiche de l'appel d'offres).
 */
export function awardedToByTenderId(candidates: readonly ProspectCandidate[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const candidate of candidates) {
    if (candidate.kind !== "AWARD" || candidate.source !== "BOAMP" || candidate.winners.length === 0) continue
    for (const tenderId of candidate.linkedSourceIds) {
      result.set(tenderId, union(result.get(tenderId) ?? [], candidate.winners))
    }
  }
  return result
}
