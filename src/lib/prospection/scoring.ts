/**
 * Veille prospection — score de pertinence déterministe (0 à 100), explicable ligne par ligne.
 *
 * Aucun appel LLM. Zone d'intervention : toute la France, donc pas de critère géographique
 * (le département reste un filtre d'affichage).
 *
 * Seuils : ≥ 60 « À traiter », 35 à 59 « À vérifier », < 35 « Masqué » (conservé pour l'audit).
 */
import type { ProspectBand, ProspectCandidate, ScoreReason } from "@/lib/prospection/prospection.types"
import { normalizeText } from "@/lib/prospection/text-normalize"

export const BAND_THRESHOLDS = { toProcess: 60, toCheck: 35 } as const

const DAY_MS = 24 * 60 * 60 * 1000

/** Familles de mots du métier (montage de chapiteaux, tentes, structures, podiums, gradins). */
const TRADE_FAMILIES: ReadonlyArray<{ code: string; label: string; pattern: RegExp }> = [
  { code: "CHAPITEAU", label: "chapiteau", pattern: /\bchapiteaux?\b/ },
  { code: "TENTE", label: "tente", pattern: /\btentes?\b/ },
  { code: "BARNUM", label: "barnum", pattern: /\bbarnums?\b/ },
  {
    code: "STRUCTURE",
    label: "structure temporaire, textile ou événementielle",
    pattern: /\bcts\b|\bstructures? (metallo ?)?textiles?\b|\bstructures? (temporaires?|ephemeres?|demontables?|modulaires?|evenementielles?)\b|\blocation de structures?\b/,
  },
  { code: "PODIUM", label: "podium, scène mobile ou praticables", pattern: /\bpodiums?\b|\bscenes? (mobiles?|demontables?|exterieures?)\b|\bpraticables?\b/ },
  { code: "GRADIN", label: "gradins ou tribunes", pattern: /\bgradins?\b|\btribunes?\b/ },
  { code: "CHALET", label: "chalets (marchés, fêtes)", pattern: /\bchalets?\b/ },
]

const SETUP_PATTERN = /\b(montage|demontage|installation|pose|mise en place|assemblage)\b/
const RENTAL_PATTERN = /\blocation\b/
const SUPPLY_PATTERN = /\b(fourniture|achat|acquisition)\b/

/** Mots qui signalent une installation temporaire : ils lèvent l'exclusion « travaux de bâtiment ». */
const TEMPORARY_PATTERN = /\b(temporaires?|ephemeres?|demontables?|location|montage et demontage)\b/

const EXCLUSIONS: ReadonlyArray<{ code: string; label: string; pattern: RegExp; unless?: RegExp }> = [
  { code: "CAMPING", label: "matériel de camping", pattern: /\bcamping\b/ },
  { code: "MEDICAL", label: "tente médicale ou sanitaire", pattern: /\btentes? (a oxygene|de decontamination|medicales?|sanitaires?)\b/ },
  { code: "CIRQUE_SPECTACLE", label: "achat de spectacle de cirque", pattern: /\b(spectacles?|representations?) de cirque\b/, unless: SETUP_PATTERN },
  {
    code: "BATIMENT",
    label: "travaux de bâtiment sur une structure permanente",
    pattern: /\b(travaux|maitrise d oeuvre|rehabilitation|refection|renovation|charpente|couverture|faux plafond|vestiaires?|gros oeuvre)\b/,
    unless: TEMPORARY_PATTERN,
  },
  { code: "HORS_METIER", label: "prestation hors métier", pattern: /\b(nettoyage|gardiennage)\b|\b(souscription|contrats?) d assurances?\b/ },
]

const STRONG_DESCRIPTORS: Readonly<Record<string, number>> = { tente: 15, stand: 10 }
const WEAK_DESCRIPTORS: Readonly<Record<string, number>> = { evenementiel: 5 }

export interface ScoreResult {
  score: number
  band: ProspectBand
  reasons: ScoreReason[]
}

export function bandForScore(score: number): ProspectBand {
  if (score >= BAND_THRESHOLDS.toProcess) return "A_TRAITER"
  if (score >= BAND_THRESHOLDS.toCheck) return "A_VERIFIER"
  return "MASQUE"
}

function finish(reasons: ScoreReason[], forcedHidden = false): ScoreResult {
  const score = Math.max(0, Math.min(100, reasons.reduce((total, reason) => total + reason.points, 0)))
  return { score: forcedHidden ? 0 : score, band: forcedHidden ? "MASQUE" : bandForScore(score), reasons }
}

/** Sans mot du métier ni descripteur fort, le délai et le type d'avis ne suffisent pas : plafond sous « À vérifier ». */
const NO_TRADE_SIGNAL_CAP = BAND_THRESHOLDS.toCheck - 5

function capWithoutTradeSignal(reasons: ScoreReason[], trade: ScoreReason[]): ScoreReason[] {
  const hasSignal = trade.some((reason) => reason.code.startsWith("METIER_") || reason.code === "DESCRIPTEUR_TENTE" || reason.code === "DESCRIPTEUR_STAND")
  if (hasSignal) return reasons
  const total = reasons.reduce((sum, reason) => sum + reason.points, 0)
  if (total <= NO_TRADE_SIGNAL_CAP) return reasons
  return [...reasons, { code: "SANS_SIGNAL_METIER", label: "Aucun mot du métier : score plafonné", points: NO_TRADE_SIGNAL_CAP - total }]
}

/** Métier (40 au plus) : première famille 30, chaque famille en plus +5 ; descripteurs BOAMP en complément. */
function tradeReasons(candidate: ProspectCandidate, text: string): ScoreReason[] {
  const reasons: ScoreReason[] = []
  const families = TRADE_FAMILIES.filter((family) => family.pattern.test(text))
  families.forEach((family, index) => {
    reasons.push({ code: `METIER_${family.code}`, label: `Mot du métier : ${family.label}`, points: index === 0 ? 30 : 5 })
  })

  let tradePoints = reasons.reduce((total, reason) => total + reason.points, 0)
  const descriptors = candidate.descriptors.map(normalizeText)
  for (const [descriptor, points] of Object.entries(families.length > 0 ? STRONG_DESCRIPTORS : { ...STRONG_DESCRIPTORS, ...WEAK_DESCRIPTORS })) {
    if (!descriptors.includes(descriptor) || tradePoints >= 40) continue
    const granted = Math.min(points, 40 - tradePoints)
    reasons.push({ code: `DESCRIPTEUR_${descriptor.toUpperCase()}`, label: `Descripteur BOAMP « ${descriptor} »`, points: granted })
    tradePoints += granted
  }
  return reasons
}

function serviceReason(text: string, max: number): ScoreReason | null {
  if (SETUP_PATTERN.test(text)) return { code: "PRESTATION_MONTAGE", label: "Montage, démontage ou installation demandés", points: max }
  if (RENTAL_PATTERN.test(text)) return { code: "PRESTATION_LOCATION", label: "Location (pose probable)", points: Math.round(max * 0.6) }
  if (SUPPLY_PATTERN.test(text)) return { code: "PRESTATION_FOURNITURE", label: "Simple fourniture ou achat", points: 0 }
  return null
}

function exclusion(text: string): ScoreReason | null {
  const hit = EXCLUSIONS.find((rule) => rule.pattern.test(text) && !(rule.unless && rule.unless.test(text)))
  return hit ? { code: `EXCLU_${hit.code}`, label: `Exclu : ${hit.label}`, points: 0 } : null
}

function scoreTender(candidate: ProspectCandidate, text: string, now: Date): ScoreResult {
  const excluded = exclusion(text)
  if (excluded) return finish([excluded], true)
  if (candidate.noticeNature === "ANNULATION") return finish([{ code: "ANNULE", label: "Avis d'annulation", points: 0 }], true)

  const trade = tradeReasons(candidate, text)
  const reasons = [...trade]
  const service = serviceReason(text, 20)
  if (service) reasons.push(service)

  if (candidate.deadlineAt) {
    const daysLeft = Math.floor((candidate.deadlineAt.getTime() - now.getTime()) / DAY_MS)
    if (daysLeft < 0) return finish([...reasons, { code: "DELAI_DEPASSE", label: "Date limite dépassée", points: 0 }], true)
    if (daysLeft >= 10) reasons.push({ code: "DELAI_CONFORTABLE", label: `${daysLeft} jours pour répondre`, points: 25 })
    else if (daysLeft >= 3) reasons.push({ code: "DELAI_COURT", label: `${daysLeft} jours pour répondre`, points: 12 })
    else reasons.push({ code: "DELAI_TRES_COURT", label: `${daysLeft} jour(s) pour répondre`, points: 0 })
  } else {
    reasons.push({ code: "DELAI_INCONNU", label: "Date limite non publiée", points: 12 })
  }

  const nature = candidate.noticeNature
  if (nature === "APPEL_OFFRE") reasons.push({ code: "AVIS_MARCHE", label: "Avis de marché ouvert", points: 15 })
  else if (nature === "PRE-INFORMATION") reasons.push({ code: "AVIS_PREINFORMATION", label: "Avis de préinformation", points: 10 })
  else if (nature === "RECTIFICATIF" || nature === "MODIFICATION") reasons.push({ code: "AVIS_RECTIFICATIF", label: "Rectificatif d'un avis", points: 5 })
  return finish(capWithoutTradeSignal(reasons, trade))
}

function scoreAward(candidate: ProspectCandidate, text: string, now: Date): ScoreResult {
  const excluded = exclusion(text)
  if (excluded) return finish([excluded], true)

  const trade = tradeReasons(candidate, text)
  const reasons = [...trade]
  const service = serviceReason(text, 10)
  if (service) reasons.push(service)

  if (candidate.winners.length > 0) {
    reasons.push({ code: "TITULAIRES_CONNUS", label: `Titulaire(s) à démarcher pour la sous-traitance : ${candidate.winners.join(", ")}`, points: 30 })
  } else {
    reasons.push({ code: "TITULAIRES_INCONNUS", label: "Titulaire non publié", points: 0 })
  }

  if (candidate.publishedAt) {
    const age = Math.floor((now.getTime() - candidate.publishedAt.getTime()) / DAY_MS)
    if (age <= 30) reasons.push({ code: "ATTRIBUTION_RECENTE", label: "Attribution de moins d'un mois", points: 20 })
    else if (age <= 90) reasons.push({ code: "ATTRIBUTION_TRIMESTRE", label: "Attribution de moins de trois mois", points: 10 })
  }
  return finish(capWithoutTradeSignal(reasons, trade))
}

/**
 * Envergure d'un festival : texte libre et hétérogène dans la source (« Intercommunale », « Nationale voir internationale »…).
 * Classement par mot-clé, du plus large au plus étroit.
 */
const REACH_CLASSES: ReadonlyArray<{ code: string; label: string; pattern: RegExp; points: number }> = [
  { code: "INTERNATIONALE", label: "Envergure internationale", pattern: /internation|inernation|mondial/, points: 40 },
  { code: "NATIONALE", label: "Envergure nationale", pattern: /\bnational/, points: 35 },
  { code: "INTERREGIONALE", label: "Envergure interrégionale ou transfrontalière", pattern: /interr+egion|transfrontal/, points: 25 },
  { code: "REGIONALE", label: "Envergure régionale", pattern: /region/, points: 15 },
  { code: "DEPARTEMENTALE", label: "Envergure départementale", pattern: /departement/, points: 8 },
  { code: "LOCALE", label: "Envergure locale", pattern: /./, points: 3 },
]
/** Sous l'envergure régionale, un festival reste masqué : la liste en compte des milliers. */
const MIN_FESTIVAL_REACH_POINTS = 15
const EVENT_LOCAL_CAP = BAND_THRESHOLDS.toCheck - 5
const FAIR_OR_SHOW_TYPES = new Set(["fairorshow", "businessevent", "saleevent"])
const OUTDOOR_DISCIPLINES = /\b(musique|arts de la rue|pluridisciplinaire|spectacle vivant|cirque)\b/

function reachReason(candidate: ProspectCandidate): ScoreReason {
  if (candidate.source === "DATATOURISME") {
    return candidate.descriptors.some((type) => FAIR_OR_SHOW_TYPES.has(type.toLowerCase()))
      ? { code: "FOIRE_SALON", label: "Foire, salon ou manifestation commerciale", points: 35 }
      : { code: "MANIFESTATION", label: "Fête ou manifestation", points: 10 }
  }
  const reach = normalizeText(candidate.reach)
  if (!reach) return { code: "ENVERGURE_INCONNUE", label: "Envergure non précisée", points: 0 }
  const match = REACH_CLASSES.find((reachClass) => reachClass.pattern.test(reach)) ?? REACH_CLASSES[REACH_CLASSES.length - 1]
  return { code: `ENVERGURE_${match.code}`, label: match.label, points: match.points }
}

function scoreEvent(candidate: ProspectCandidate, now: Date): ScoreResult {
  const reach = reachReason(candidate)
  const reasons: ScoreReason[] = [reach]

  const discipline = normalizeText(candidate.descriptors.join(" "))
  reasons.push(
    OUTDOOR_DISCIPLINES.test(discipline)
      ? { code: "DISCIPLINE_PLEIN_AIR", label: "Discipline souvent en plein air (structures probables)", points: 20 }
      : { code: "DISCIPLINE_AUTRE", label: "Discipline plutôt en salle", points: 5 },
  )

  const period = normalizeText(candidate.eventPeriod)
  if (candidate.eventStartAt) {
    const daysAhead = Math.floor((candidate.eventStartAt.getTime() - now.getTime()) / DAY_MS)
    if (daysAhead < 0) return finish([...reasons, { code: "EVENEMENT_PASSE", label: "Événement passé", points: 0 }], true)
    reasons.push(
      daysAhead >= 60 && daysAhead <= 270
        ? { code: "FENETRE_PROSPECTION", label: "Entre 2 et 9 mois avant l'événement : bon moment pour démarcher", points: 20 }
        : { code: "HORS_FENETRE", label: daysAhead < 60 ? "Moins de 2 mois avant l'événement" : "Plus de 9 mois avant l'événement", points: 8 },
    )
  } else if (period.startsWith("saison")) {
    reasons.push({ code: "PERIODE_ETE", label: "Se déroule l'été (structures extérieures)", points: 20 })
  } else if (period.startsWith("avant saison")) {
    reasons.push({ code: "PERIODE_PRINTEMPS", label: "Se déroule au printemps", points: 12 })
  } else if (period.startsWith("apres saison")) {
    reasons.push({ code: "PERIODE_AUTOMNE", label: "Se déroule à l'automne ou l'hiver", points: 8 })
  }

  if (candidate.creationYear && candidate.creationYear <= now.getUTCFullYear() - 10) {
    reasons.push({ code: "RECURRENT", label: `Récurrent depuis ${candidate.creationYear}`, points: 10 })
  }

  const total = reasons.reduce((sum, reason) => sum + reason.points, 0)
  if (candidate.source === "FESTIVALS_CULTURE" && reach.points < MIN_FESTIVAL_REACH_POINTS && total > EVENT_LOCAL_CAP) {
    reasons.push({ code: "ENVERGURE_LOCALE_PLAFOND", label: "Envergure inférieure à régionale : score plafonné", points: EVENT_LOCAL_CAP - total })
  }
  return finish(reasons)
}

export function scoreCandidate(candidate: ProspectCandidate, now: Date): ScoreResult {
  const text = normalizeText(candidate.title)
  if (candidate.kind === "AWARD") return scoreAward(candidate, text, now)
  if (candidate.kind === "EVENT") return scoreEvent(candidate, now)
  return scoreTender(candidate, text, now)
}
