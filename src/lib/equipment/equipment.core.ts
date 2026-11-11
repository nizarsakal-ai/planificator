/**
 * Lot B Planificator V2 : règles métier PURES du matériel et de la location (sans base, testables isolément).
 * Le service (`equipment.service.ts`) les applique avant toute écriture ; la base porte les mêmes invariants en CHECK.
 *
 * Périodes : une réservation porte sur des JOURS entiers, en intervalle semi-ouvert [début, fin + 1 jour) à minuit UTC.
 * Deux réservations du même équipement se chevauchent si a.début < b.fin ET b.début < a.fin ; une réservation qui se
 * termine le 10 et une autre qui commence le 11 ne se chevauchent donc pas. Une sortie non rendue après sa fin prévue
 * continue d'occuper l'équipement jusqu'à son retour (fin effective = max(fin prévue, maintenant)).
 * Revue B v2 (B-R1) : symétriquement, une sortie ANTICIPÉE occupe l'équipement dès sa sortie constatée (début effectif =
 * min(début prévu, sortie)). Les dates prévues restent inchangées ; tous les contrôles d'occupation utilisent la période
 * EFFECTIVE [début effectif, fin effective).
 */

export type EquipmentStatus = "AVAILABLE" | "OUT" | "MAINTENANCE" | "RETIRED"
export type EquipmentCondition = "GOOD" | "WORN" | "DAMAGED"
export type EquipmentOwnership = "OWNED" | "RENTED"
export type BookingStatus = "RESERVED" | "CHECKED_OUT" | "RETURNED" | "CANCELLED"
export type RentalStatus = "ACTIVE" | "CLOSED" | "CANCELLED"

export const EQUIPMENT_CONDITIONS: readonly EquipmentCondition[] = ["GOOD", "WORN", "DAMAGED"]
export const DAY_MS = 86_400_000
/** Durée maximale d'une réservation ou d'un contrat (garde-fou contre une saisie erronée). */
export const MAX_PERIOD_DAYS = 731

export const EQUIPMENT_ERRORS = {
  notFound: "Élément introuvable.",
  invalidNumber: "Numéro d'équipement invalide (1 à 40 caractères : lettres, chiffres, . _ / -).",
  duplicateNumber: "Un équipement porte déjà ce numéro.",
  invalidName: "Nom ou catégorie d'équipement invalide.",
  invalidPeriod: "Période invalide : la date de fin doit être égale ou postérieure à la date de début.",
  periodTooLong: "Période trop longue.",
  retired: "Cet équipement est réformé.",
  overlap: "L'équipement est déjà réservé ou sorti sur une partie de cette période.",
  notCovered: "Équipement loué : la période doit être couverte par un contrat de location actif.",
  notReserved: "Seule une réservation en attente peut sortir ou être annulée.",
  notCheckedOut: "Seul un équipement sorti peut être rendu.",
  unavailable: "L'équipement n'est pas disponible (déjà sorti, en entretien ou réformé).",
  invalidCondition: "État constaté invalide.",
  invalidStatusChange: "Changement d'état impossible depuis l'état actuel.",
  notRented: "Un contrat de location ne concerne qu'un équipement loué.",
  contractOverlap: "Un autre contrat actif couvre déjà une partie de cette période.",
  contractNotActive: "Ce contrat n'est plus actif.",
  contractCancelled: "Un contrat annulé ne peut pas être rapproché d'une facture.",
  returnBeforeStart: "La date de retour précède le début du contrat.",
  returnInFuture: "La date de retour au loueur ne peut pas être postérieure à aujourd'hui.",
  stillOut: "L'équipement est encore sorti : enregistrez d'abord son retour.",
  bookingsAfterReturn: "Des réservations dépendent de ce contrat après la date de retour : annulez-les d'abord.",
  bookingsOnContract: "Des réservations en cours dépendent de ce contrat : annulez-les d'abord.",
  invalidAmount: "Montant invalide.",
  invalidMaintenance: "Entretien invalide : une description et une date prévue ou réalisée sont nécessaires.",
  supplierInvoiceMismatch: "La facture fournisseur ne correspond pas au loueur du contrat.",
  conflict: "L'élément a changé entre-temps ; rechargez la page.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const okv = <T>(value: T): Plan<T> => ({ ok: true, value })
const ko = <T = never>(error: string): Plan<T> => ({ ok: false, error })

// ─────────────────────────────── Saisies ───────────────────────────────

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** « AAAA-MM-JJ » → minuit UTC de ce jour ; null si la date n'existe pas (31 février…) ou hors 2000-2100. */
export function parseDay(input: string): Date | null {
  const m = DAY_RE.exec(input.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 2000 || y > 2100) return null
  const t = Date.UTC(y, mo - 1, d)
  const date = new Date(t)
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null
}
export const formatDay = (d: Date) => d.toISOString().slice(0, 10)

const NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/
export function validateEquipmentIdentity(input: { number: string; name: string; category: string }): Plan<{ number: string; name: string; category: string }> {
  const number = input.number.trim()
  const name = input.name.trim()
  const category = input.category.trim()
  if (!NUMBER_RE.test(number)) return ko(EQUIPMENT_ERRORS.invalidNumber)
  if (!name || name.length > 160 || !category || category.length > 80) return ko(EQUIPMENT_ERRORS.invalidName)
  return okv({ number, name, category })
}

/** Montant facultatif en centimes : entier ≥ 0 et ≤ 2 000 000 000 (colonne INTEGER), ou null. */
export function validCents(v: number | null | undefined): boolean {
  return v === null || v === undefined || (Number.isSafeInteger(v) && v >= 0 && v <= 2_000_000_000)
}

// ─────────────────────────────── Périodes ───────────────────────────────

export interface Period { startAt: Date; endAt: Date }

/** Jours [premier, dernier] inclus → intervalle semi-ouvert [premier, dernier + 1 jour). */
export function dayPeriod(firstDay: Date, lastDay: Date): Plan<Period> {
  if (!(lastDay.getTime() >= firstDay.getTime())) return ko(EQUIPMENT_ERRORS.invalidPeriod)
  const days = Math.round((lastDay.getTime() - firstDay.getTime()) / DAY_MS) + 1
  if (days > MAX_PERIOD_DAYS) return ko(EQUIPMENT_ERRORS.periodTooLong)
  return okv({ startAt: firstDay, endAt: new Date(lastDay.getTime() + DAY_MS) })
}

export const overlaps = (a: Period, b: Period) => a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime()

export interface BookingLike extends Period { id: string; status: BookingStatus; checkedOutAt?: Date | null }

/** Début effectif (B-R1) : une réservation sortie AVANT son début prévu occupe l'équipement dès la sortie constatée. */
export function effectiveStart(b: BookingLike): Date {
  return b.status === "CHECKED_OUT" && b.checkedOutAt && b.checkedOutAt.getTime() < b.startAt.getTime() ? b.checkedOutAt : b.startAt
}

/** Fin effective : une sortie non rendue occupe l'équipement au moins jusqu'à maintenant. */
export function effectiveEnd(b: BookingLike, now: Date): Date {
  return b.status === "CHECKED_OUT" && now.getTime() > b.endAt.getTime() ? now : b.endAt
}

/** Période d'occupation EFFECTIVE d'une réservation : [début effectif, fin effective). */
export const effectivePeriod = (b: BookingLike, now: Date): Period => ({ startAt: effectiveStart(b), endAt: effectiveEnd(b, now) })

/** Première réservation active (en attente ou sortie) qui chevauche la période demandée, en ignorant `excludeId`. */
export function findConflict(bookings: readonly BookingLike[], wanted: Period, now: Date, excludeId?: string): BookingLike | null {
  for (const b of bookings) {
    if (b.id === excludeId || (b.status !== "RESERVED" && b.status !== "CHECKED_OUT")) continue
    if (overlaps(effectivePeriod(b, now), wanted)) return b
  }
  return null
}

export interface ContractLike { id: string; status: RentalStatus; startDate: Date; endDate: Date }
/** Intervalle semi-ouvert couvert par un contrat : [début, fin + 1 jour). */
export const contractPeriod = (c: Pick<ContractLike, "startDate" | "endDate">): Period => ({ startAt: c.startDate, endAt: new Date(c.endDate.getTime() + DAY_MS) })
/** Un seul contrat ACTIF doit couvrir toute la période (pas d'assemblage de contrats). */
export function coveringContract(contracts: readonly ContractLike[], wanted: Period): ContractLike | null {
  return contracts.find((c) => {
    if (c.status !== "ACTIVE") return false
    const p = contractPeriod(c)
    return p.startAt.getTime() <= wanted.startAt.getTime() && wanted.endAt.getTime() <= p.endAt.getTime()
  }) ?? null
}

// ─────────────────────────────── Réservations ───────────────────────────────

export function planBooking(input: {
  equipmentStatus: EquipmentStatus
  ownership: EquipmentOwnership
  wanted: Period
  bookings: readonly BookingLike[]
  contracts: readonly ContractLike[]
  now: Date
  depositCents?: number | null
}): Plan<{ coveringContractId: string | null }> {
  if (input.equipmentStatus === "RETIRED") return ko(EQUIPMENT_ERRORS.retired)
  if (!validCents(input.depositCents)) return ko(EQUIPMENT_ERRORS.invalidAmount)
  if (findConflict(input.bookings, input.wanted, input.now)) return ko(EQUIPMENT_ERRORS.overlap)
  if (input.ownership === "RENTED") {
    const c = coveringContract(input.contracts, input.wanted)
    if (!c) return ko(EQUIPMENT_ERRORS.notCovered)
    return okv({ coveringContractId: c.id })
  }
  return okv({ coveringContractId: null })
}

/** Sortie : réservation en attente, équipement disponible (ni sorti, ni en entretien, ni réformé). Une sortie
 * anticipée occupe l'équipement dès maintenant : elle est refusée si une autre réservation active tombe entre
 * maintenant et la fin prévue (sinon la réservation antérieure ne pourrait plus sortir). */
export function planCheckout(input: {
  booking: BookingLike
  equipmentStatus: EquipmentStatus
  condition: string
  others: readonly BookingLike[]
  now: Date
}): Plan<EquipmentCondition> {
  const { booking, equipmentStatus, condition, others, now } = input
  if (booking.status !== "RESERVED") return ko(EQUIPMENT_ERRORS.notReserved)
  if (equipmentStatus !== "AVAILABLE") return ko(EQUIPMENT_ERRORS.unavailable)
  const occupied: Period = {
    startAt: now.getTime() < booking.startAt.getTime() ? now : booking.startAt,
    endAt: now.getTime() > booking.endAt.getTime() ? now : booking.endAt,
  }
  if (findConflict(others, occupied, now, booking.id)) return ko(EQUIPMENT_ERRORS.overlap)
  if (!EQUIPMENT_CONDITIONS.includes(condition as EquipmentCondition)) return ko(EQUIPMENT_ERRORS.invalidCondition)
  return okv(condition as EquipmentCondition)
}

/** Retour : l'état constaté devient l'état de l'équipement ; endommagé ⇒ passage en entretien, sinon disponible. */
export function planReturn(bookingStatus: BookingStatus, condition: string): Plan<{ condition: EquipmentCondition; nextStatus: EquipmentStatus }> {
  if (bookingStatus !== "CHECKED_OUT") return ko(EQUIPMENT_ERRORS.notCheckedOut)
  if (!EQUIPMENT_CONDITIONS.includes(condition as EquipmentCondition)) return ko(EQUIPMENT_ERRORS.invalidCondition)
  const c = condition as EquipmentCondition
  return okv({ condition: c, nextStatus: c === "DAMAGED" ? "MAINTENANCE" : "AVAILABLE" })
}

/** Changements d'état manuels. OUT n'est jamais posé à la main (seulement par une sortie) ; un équipement sorti ne
 * change pas d'état à la main ; RETIRED est définitif. */
export function planStatusChange(from: EquipmentStatus, to: string): Plan<EquipmentStatus> {
  const allowed: Record<EquipmentStatus, EquipmentStatus[]> = {
    AVAILABLE: ["MAINTENANCE", "RETIRED"],
    MAINTENANCE: ["AVAILABLE", "RETIRED"],
    OUT: [],
    RETIRED: [],
  }
  return allowed[from].includes(to as EquipmentStatus) ? okv(to as EquipmentStatus) : ko(EQUIPMENT_ERRORS.invalidStatusChange)
}

// ─────────────────────────────── Location ───────────────────────────────

/** Nombre de jours facturés, bornes incluses (du 1er au 3 = 3 jours). */
export const billedDays = (startDate: Date, lastDay: Date) => Math.round((lastDay.getTime() - startDate.getTime()) / DAY_MS) + 1

/** Coût d'un contrat : jours facturés × tarif journalier + frais fixes, en centimes (BigInt, jamais de flottant). */
export function rentalCostCents(c: { startDate: Date; lastDay: Date; dailyRateCents: number; fixedFeesCents: number }): Plan<bigint> {
  if (c.lastDay.getTime() < c.startDate.getTime()) return ko(EQUIPMENT_ERRORS.returnBeforeStart)
  if (!validCents(c.dailyRateCents) || !validCents(c.fixedFeesCents)) return ko(EQUIPMENT_ERRORS.invalidAmount)
  return okv(BigInt(billedDays(c.startDate, c.lastDay)) * BigInt(c.dailyRateCents) + BigInt(c.fixedFeesCents))
}

export function planRentalContract(input: {
  ownership: EquipmentOwnership
  equipmentStatus: EquipmentStatus
  startDate: Date
  endDate: Date
  dailyRateCents: number
  fixedFeesCents: number
  contracts: readonly ContractLike[]
}): Plan<Period> {
  if (input.ownership !== "RENTED") return ko(EQUIPMENT_ERRORS.notRented)
  if (input.equipmentStatus === "RETIRED") return ko(EQUIPMENT_ERRORS.retired)
  if (!validCents(input.dailyRateCents) || !validCents(input.fixedFeesCents)) return ko(EQUIPMENT_ERRORS.invalidAmount)
  const p = dayPeriod(input.startDate, input.endDate)
  if (!p.ok) return p
  if (input.contracts.some((c) => c.status === "ACTIVE" && overlaps(contractPeriod(c), p.value))) return ko(EQUIPMENT_ERRORS.contractOverlap)
  return p
}

/** Clôture : retour au loueur le jour `returnedOn` (≥ début). Refus si l'équipement est encore sorti, ou si une
 * réservation active de cet équipement dépasse la date de retour tout en relevant de ce contrat. Le coût est figé. */
export function planRentalClose(input: {
  contract: ContractLike & { dailyRateCents: number; fixedFeesCents: number }
  returnedOn: Date
  bookings: readonly BookingLike[]
  now: Date
}): Plan<bigint> {
  const c = input.contract
  if (c.status !== "ACTIVE") return ko(EQUIPMENT_ERRORS.contractNotActive)
  if (input.returnedOn.getTime() < c.startDate.getTime()) return ko(EQUIPMENT_ERRORS.returnBeforeStart)
  // Le coût est figé sur un retour constaté : jamais sur une date à venir (jour civil de Paris).
  if (input.returnedOn.getTime() > parisToday(input.now).getTime()) return ko(EQUIPMENT_ERRORS.returnInFuture)
  // Revue indépendante : borne de saisie (le coût figé est irréversible), comme pour la création.
  if (billedDays(c.startDate, input.returnedOn) > MAX_PERIOD_DAYS) return ko(EQUIPMENT_ERRORS.periodTooLong)
  const contract = contractPeriod(c)
  // Seule une sortie en cours qui relève de CE contrat (chevauchement avec sa période) bloque la clôture ; une sortie
  // sous un contrat ultérieur du même équipement ne la bloque pas (revue indépendante).
  if (input.bookings.some((b) => b.status === "CHECKED_OUT" && overlaps(effectivePeriod(b, input.now), contract))) return ko(EQUIPMENT_ERRORS.stillOut)
  const afterReturn: Period = { startAt: new Date(input.returnedOn.getTime() + DAY_MS), endAt: contract.endAt }
  if (afterReturn.startAt.getTime() < afterReturn.endAt.getTime()
    && input.bookings.some((b) => b.status === "RESERVED" && overlaps(b, afterReturn))) return ko(EQUIPMENT_ERRORS.bookingsAfterReturn)
  return rentalCostCents({ startDate: c.startDate, lastDay: input.returnedOn, dailyRateCents: c.dailyRateCents, fixedFeesCents: c.fixedFeesCents })
}

/** Annulation d'un contrat actif sans réservation active qui en dépende. */
export function planRentalCancel(contract: ContractLike, bookings: readonly BookingLike[], now: Date): Plan<null> {
  if (contract.status !== "ACTIVE") return ko(EQUIPMENT_ERRORS.contractNotActive)
  const p = contractPeriod(contract)
  if (bookings.some((b) => (b.status === "RESERVED" || b.status === "CHECKED_OUT") && overlaps(effectivePeriod(b, now), p))) return ko(EQUIPMENT_ERRORS.bookingsOnContract)
  return okv(null)
}

/** Coût engagé d'un contrat actif (période prévue complète), pour l'affichage et le futur lot C. */
export function committedRentalCents(c: { startDate: Date; endDate: Date; dailyRateCents: number; fixedFeesCents: number }): bigint {
  return BigInt(billedDays(c.startDate, c.endDate)) * BigInt(c.dailyRateCents) + BigInt(c.fixedFeesCents)
}

// ─────────────────────────────── Entretien ───────────────────────────────

export function validateMaintenance(input: { description: string; plannedOn: Date | null; performedOn: Date | null; costCents: number | null }): Plan<{ description: string }> {
  const description = input.description.trim()
  if (!description || description.length > 500 || (!input.plannedOn && !input.performedOn)) return ko(EQUIPMENT_ERRORS.invalidMaintenance)
  if (!validCents(input.costCents)) return ko(EQUIPMENT_ERRORS.invalidAmount)
  return okv({ description })
}

/** Entretien prévu, non réalisé, dont la date est passée (jour courant exclu). */
export const maintenanceOverdue = (m: { plannedOn: Date | null; performedOn: Date | null }, today: Date) =>
  m.performedOn === null && m.plannedOn !== null && m.plannedOn.getTime() < today.getTime()

/** Minuit UTC du jour civil de Paris pour `now` (les dates du module sont des jours, pas des instants). */
export function parisToday(now: Date): Date {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  return parseDay(s) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}
