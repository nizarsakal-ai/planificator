/**
 * Veille prospection — ordre de priorité géographique (consigne de Nizar, 4 novembre 2026).
 *
 * 1. Mairies de Paris et d'Île-de-France
 * 2. Montage et démontage en Île-de-France
 * 3. Autres pistes en Île-de-France
 * 4. Départements voisins de l'Île-de-France
 * 5. Reste de la France
 *
 * La priorité ne modifie pas le score (pertinence métier) : elle ordonne et regroupe l'affichage.
 * Le score trie ensuite à l'intérieur de chaque groupe.
 */
import type { ProspectCandidate, ProspectKind, ScoreReason } from "@/lib/prospection/prospection.types"
import { hasTradeSignal } from "@/lib/prospection/scoring"
import { normalizeText } from "@/lib/prospection/text-normalize"

export const ILE_DE_FRANCE = new Set(["75", "77", "78", "91", "92", "93", "94", "95"])
/** Départements limitrophes de l'Île-de-France. */
export const IDF_NEIGHBOURS = new Set(["02", "10", "27", "28", "45", "51", "60", "89"])

export const PRIORITY_GROUPS = [
  { rank: 1, label: "Mairies de Paris et d'Île-de-France" },
  { rank: 2, label: "Montage et démontage en Île-de-France" },
  { rank: 3, label: "Autres pistes en Île-de-France" },
  { rank: 4, label: "Départements voisins" },
  { rank: 5, label: "Reste de la France" },
] as const

export type PriorityRank = (typeof PRIORITY_GROUPS)[number]["rank"]

const TOWN_HALL_PATTERN = /\b(mairie|ville|commune|ccas|arrondissement|municipal|municipale)\b/
const SETUP_REMOVAL_PATTERN = /\b(montage|demontage)\b/

export function isTownHall(organization: string | null): boolean {
  return TOWN_HALL_PATTERN.test(normalizeText(organization))
}

export function priorityRankFor(candidate: Pick<ProspectCandidate, "organization" | "title" | "departmentCodes">): PriorityRank {
  const inIdf = candidate.departmentCodes.some((code) => ILE_DE_FRANCE.has(code))
  if (inIdf) {
    if (isTownHall(candidate.organization)) return 1
    if (SETUP_REMOVAL_PATTERN.test(normalizeText(candidate.title))) return 2
    return 3
  }
  if (candidate.departmentCodes.some((code) => IDF_NEIGHBOURS.has(code))) return 4
  return 5
}

export function priorityLabel(rank: number): string {
  return PRIORITY_GROUPS.find((group) => group.rank === rank)?.label ?? PRIORITY_GROUPS[PRIORITY_GROUPS.length - 1].label
}

/** Les événements n'ont ni acheteur ni prestation : seuls l'Île-de-France, les voisins et le reste s'appliquent. */
export function priorityGroupsFor(kind: ProspectKind): ReadonlyArray<{ rank: PriorityRank; label: string }> {
  if (kind !== "EVENT") return PRIORITY_GROUPS
  return PRIORITY_GROUPS.filter((group) => group.rank >= 3).map((group) => (group.rank === 3 ? { ...group, label: "Île-de-France" } : group))
}

export const RECENTLY_CLOSED_WINDOW_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Marché clos depuis moins de 60 jours, dans les groupes 1 ou 2, qui aurait été retenu : à recontacter au prochain marché
 * (une mairie qui achète ce type de prestation la remet souvent en concurrence l'année suivante).
 */
export function isRecentlyClosedWorthRecontact(
  row: { kind: string; deadlineAt: Date | null; priorityGroup: number; band: string; reasons: readonly ScoreReason[] },
  now: Date,
): boolean {
  if (row.kind !== "TENDER" || row.priorityGroup > 2 || !row.deadlineAt) return false
  const deadline = row.deadlineAt.getTime()
  if (deadline >= now.getTime() || deadline < now.getTime() - RECENTLY_CLOSED_WINDOW_DAYS * DAY_MS) return false
  if (row.reasons.some((reason) => reason.code.startsWith("EXCLU_") || reason.code === "ANNULE")) return false
  return row.band !== "MASQUE" || hasTradeSignal(row.reasons)
}
