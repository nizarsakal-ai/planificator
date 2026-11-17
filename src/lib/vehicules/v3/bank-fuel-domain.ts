/**
 * Pleins payés par carte bancaire d'entreprise : repérage dans les relevés importés et rattachement au
 * camion, sans configuration (règle pure, aucune base, aucun réseau).
 *
 * Ordre de rattachement d'une opération carburant :
 *   1. déjà enregistrée (référence « BANQUE:<id> », ou même montant à ± 1 jour sur un camion) ;
 *   2. carte reconnue : la carte (4 derniers chiffres du libellé) a déjà servi à ce camion — appris des
 *      tickets enregistrés et des jours où un seul camion était en tournée ;
 *   3. un seul camion en tournée ce jour-là ;
 *   4. ville de la station (dans le libellé) présente dans les étapes d'une seule tournée du jour ;
 *   5. sinon : à confirmer, avec les camions possibles.
 */

export interface BankFuelLine { id: string; day: string; label: string; amountCents: number }
export interface FleetTour { truckId: string; startDay: string; endDay: string; stopAddresses: string[] }
export interface RecordedFuelExpense { truckId: string; day: string; amountCents: number; reference: string | null }

export type FuelResolution =
  | { kind: "RECORDED"; truckId: string }
  | { kind: "CARD"; truckId: string; card: string }
  | { kind: "ONLY_TOUR"; truckId: string }
  | { kind: "TOWN"; truckId: string; town: string }
  | { kind: "UNRESOLVED"; candidates: string[] }

export interface ResolvedFuelLine extends BankFuelLine { card: string | null; resolution: FuelResolution }

export const BANK_REFERENCE_PREFIX = "BANQUE:"

const FUEL_PATTERN = new RegExp(
  [
    "TOTAL ?ENERGIES", "\\bTOTAL\\b", "\\bESSO\\b", "\\bSHELL\\b", "\\bBP\\b", "\\bAVIA\\b", "\\bAS ?24\\b", "\\bDYNEFF\\b",
    "\\bENI\\b", "\\bAGIP\\b", "\\bELAN\\b", "\\bCARBU", "\\bSTATION\\b", "\\bSTA\\.? ?SERV", "\\bGAZOLE\\b", "\\bGASOIL\\b",
  ].join("|"),
  "i",
)

export type CardSpendCategory = "FUEL" | "TOLL" | "MEAL" | "HOTEL"

const TOLL_PATTERN = /\b(PEAGE|PEAGES|AUTOROUTE|VINCI|SANEF|APRR|AREA|ASF|ESCOTA|COFIROUTE|ATMB|SAPN|ALIAE|ATLANDES|ALBEA|BIP ?& ?GO|ULYS)\b/
const HOTEL_PATTERN = /\b(HOTEL|HOTELS|IBIS|B ?& ?B HOTEL|BB HOTEL|CAMPANILE|KYRIAD|PREMIERE CLASSE|FORMULE 1|F1 HOTEL|ACCOR|NOVOTEL|MERCURE|BOOKING|AIRBNB|LOGIS|BEST WESTERN|HOTEL F1|APPART ?HOTEL|ADAGIO)\b/
const MEAL_PATTERN = /\b(RESTAU|RESTAURANT|BRASSERIE|PIZZ|BURGER|MCDO|MC DONALD|MCDONALD|KFC|QUICK|BURGER KING|SUBWAY|BOULANG|BOULANGERIE|PAUL|KEBAB|SUSHI|CAFE|BISTRO|TRAITEUR|BUFFALO|COURTEPAILLE|FLUNCH|DEL ARTE|SNACK|CROUS)\b/

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()

/** Opération de débit dont le libellé désigne une station-service. */
export function isFuelLine(label: string, amountCents: number): boolean {
  const l = normalize(label).trim()
  // Virements et prélèvements exclus : un plein se paie à la carte.
  if (/^(VIR|VIREMENT|PRLV|PRELEVEMENT|CHQ|CHEQUE|REM)\b/.test(l)) return false
  return amountCents < 0 && FUEL_PATTERN.test(l)
}

/** Nature d'un paiement par carte d'après son libellé (débits seulement) ; null si non reconnu. */
export function classifyCardSpend(label: string, amountCents: number): CardSpendCategory | null {
  if (amountCents >= 0) return null
  if (isFuelLine(label, amountCents)) return "FUEL"
  const l = normalize(label)
  if (/^(VIR|VIREMENT|PRLV|PRELEVEMENT|CHQ|CHEQUE|REM)\b/.test(l.trim())) return null
  if (TOLL_PATTERN.test(l)) return "TOLL"
  if (HOTEL_PATTERN.test(l)) return "HOTEL"
  if (MEAL_PATTERN.test(l)) return "MEAL"
  return null
}

/** 4 derniers chiffres d'une carte masquée (« CARTE X1234 », « CB*1234 », « ****1234 ») ; jamais une date. */
export function cardDigits(label: string): string | null {
  const m = normalize(label).match(/[X*•]{1,16} ?(\d{4})\b/)
  return m ? m[1] : null
}

/** Commune d'une adresse française (« 15 rue X, 11170 Alzonne » → « ALZONNE »). */
export function cityOf(address: string): string | null {
  const m = normalize(address).match(/\b\d{5}\s+([A-Z][A-Z' -]{1,60})/)
  if (!m) return null
  const city = m[1].replace(/\bCEDEX\b.*$/, "").replace(/[^A-Z]+$/, "").trim()
  return city.length >= 3 ? city : null
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000
const toursOn = (day: string, tours: readonly FleetTour[]) => tours.filter((t) => t.startDay <= day && day <= t.endDay)

function recordedTruck(line: BankFuelLine, expenses: readonly RecordedFuelExpense[]): string | null {
  const byRef = expenses.find((e) => e.reference === `${BANK_REFERENCE_PREFIX}${line.id}`)
  if (byRef) return byRef.truckId
  const amount = -line.amountCents
  const same = expenses.filter((e) => e.amountCents === amount && dayDiff(e.day, line.day) <= 1 && !e.reference?.startsWith(BANK_REFERENCE_PREFIX))
  return same.length >= 1 ? same[0].truckId : null
}

/**
 * Carte → camion, appris de l'historique. Preuve forte (2 points) : ticket ou plein déjà enregistré sur le
 * camion. Preuve faible (1 point) : seul camion en tournée ce jour-là. Une carte n'est reconnue qu'avec
 * au moins 2 points et une avance stricte sur tout autre camion : un plein isolé ne suffit jamais.
 */
export function learnCardTrucks(lines: readonly BankFuelLine[], tours: readonly FleetTour[], expenses: readonly RecordedFuelExpense[]): Map<string, string> {
  const votes = new Map<string, Map<string, number>>()
  const vote = (card: string, truckId: string, weight: number) => {
    const m = votes.get(card) ?? new Map<string, number>()
    m.set(truckId, (m.get(truckId) ?? 0) + weight)
    votes.set(card, m)
  }
  for (const line of lines) {
    const card = cardDigits(line.label)
    if (!card) continue
    const recorded = recordedTruck(line, expenses)
    if (recorded) { vote(card, recorded, 2); continue }
    const onTour = [...new Set(toursOn(line.day, tours).map((t) => t.truckId))]
    if (onTour.length === 1) vote(card, onTour[0], 1)
  }
  const out = new Map<string, string>()
  for (const [card, m] of votes) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1])
    if (ranked[0][1] >= 2 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) out.set(card, ranked[0][0])
  }
  return out
}

export function resolveFuelLines(input: {
  lines: readonly BankFuelLine[]
  tours: readonly FleetTour[]
  expenses: readonly RecordedFuelExpense[]
}): ResolvedFuelLine[] {
  const cards = learnCardTrucks(input.lines, input.tours, input.expenses)
  return input.lines.map((line) => {
    const card = cardDigits(line.label)
    const recorded = recordedTruck(line, input.expenses)
    if (recorded) return { ...line, card, resolution: { kind: "RECORDED", truckId: recorded } }
    if (card && cards.has(card)) return { ...line, card, resolution: { kind: "CARD", truckId: cards.get(card)!, card } }
    const today = toursOn(line.day, input.tours)
    const trucks = [...new Set(today.map((t) => t.truckId))]
    if (trucks.length === 1) return { ...line, card, resolution: { kind: "ONLY_TOUR", truckId: trucks[0] } }
    if (trucks.length > 1) {
      const label = normalize(line.label)
      const hits = new Map<string, string>()
      for (const t of today) {
        for (const address of t.stopAddresses) {
          const city = cityOf(address)
          if (city && new RegExp(`\\b${city.replace(/[^A-Z' -]/g, "")}\\b`).test(label)) hits.set(t.truckId, city)
        }
      }
      if (hits.size === 1) {
        const [[truckId, town]] = [...hits.entries()]
        return { ...line, card, resolution: { kind: "TOWN", truckId, town } }
      }
    }
    return { ...line, card, resolution: { kind: "UNRESOLVED", candidates: trucks } }
  })
}

/** Clé d'idempotence stable (format UUID) dérivée de l'opération : un double clic n'enregistre qu'une dépense. */
export function bankLineIdempotencyKey(hashHex: string): string {
  const h = hashHex.padEnd(32, "0").slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Commande de création d'une dépense carburant à partir d'une opération bancaire (statut « à valider »). */
export function bankFuelExpenseCommand(line: { id: string; day: string; label: string; amount: string; card: string | null }) {
  return {
    action: "CREATE" as const,
    data: {
      category: "FUEL" as const,
      // Midi UTC : toujours le même jour civil en France, quelle que soit l'heure d'été.
      occurredAt: `${line.day}T12:00:00.000Z`,
      amount: line.amount,
      currency: "EUR",
      supplier: line.label.slice(0, 200),
      reference: `${BANK_REFERENCE_PREFIX}${line.id}`,
      notes: `Relevé bancaire${line.card ? `, carte •${line.card}` : ""}. Ajoutez le ticket pour les litres.`,
    },
  }
}
