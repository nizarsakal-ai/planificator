/**
 * Ticket de carburant photographié par le chauffeur : règles pures (aucune base, aucun réseau).
 *
 * Le ticket devient le justificatif comptable (document EXPENSE_RECEIPT du camion) et :
 *   - complète le plein déjà créé depuis le relevé bancaire (référence « BANQUE:<id> », même montant,
 *     à ± 1 jour, sans justificatif) : litres et ticket ajoutés, référence bancaire conservée ;
 *   - sinon crée le plein « à valider ». Le relevé importé plus tard le reconnaîtra (même montant à ± 1 jour)
 *     et ne le recréera pas.
 */
import { createHash } from "node:crypto"
import { z } from "zod"
import { BANK_REFERENCE_PREFIX } from "./bank-fuel-domain"

/** Ancienneté maximale d'un ticket déposé par le chauffeur. */
export const DRIVER_TICKET_MAX_AGE_DAYS = 62

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const money = z.string().trim().regex(/^(?:0|[1-9]\d{0,7})(?:[.,]\d{1,2})?$/)
const litres = z.string().trim().regex(/^(?:0|[1-9]\d{0,4})(?:[.,]\d{1,3})?$/)

/**
 * Compteur du camion lu sur le ticket ou saisi par le chauffeur : facultatif et JAMAIS bloquant. Une
 * valeur absente, illisible ou hors bornes est simplement ignorée (le ticket est enregistré sans).
 */
export function optionalTicketMileage(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d[\d\s.]*\s*$/.test(value) ? Number(value.replace(/[\s.]/g, "")) : NaN
  return Number.isInteger(n) && n > 0 && n <= 9_999_999 ? n : null
}

export const driverTicketSchema = z.object({
  truckId: z.string().trim().min(1).max(200),
  amount: money,
  litres: litres.nullable().optional(),
  day,
  station: z.string().trim().max(200).nullable().optional(),
  mileage: z.unknown().optional().transform(optionalTicketMileage),
}).strict()

export type DriverTicketInput = Omit<z.infer<typeof driverTicketSchema>, "mileage"> & { mileage?: number | null }

export function normalizeDecimal(v: string): string { return v.trim().replace(",", ".") }
export const toCents = (amount: string) => Math.round(Number(normalizeDecimal(amount)) * 100)

/** Date du ticket : ni future, ni trop ancienne (`today` = jour civil de l'entreprise). */
export function ticketDayAllowed(ticketDay: string, today: string): boolean {
  if (ticketDay > today) return false
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ticketDay}T00:00:00Z`)) / 86_400_000
  return age <= DRIVER_TICKET_MAX_AGE_DAYS
}

export interface CandidateExpense {
  id: string
  revision: number
  day: string
  amountCents: number
  currency: string
  reference: string | null
  supplier: string | null
  notes: string | null
  litres: string | null
  mileageObservation: number | null
  documentVersionId: string | null
  status: string
}

/** Plein bancaire à compléter : un seul candidat sûr, sinon aucun (création d'un plein distinct). */
export function findBankExpenseToComplete(candidates: readonly CandidateExpense[], amountCents: number, ticketDay: string): CandidateExpense | null {
  const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000
  const matches = candidates.filter((e) =>
    e.reference?.startsWith(BANK_REFERENCE_PREFIX) &&
    !e.documentVersionId &&
    e.currency === "EUR" &&
    (e.status === "PENDING" || e.status === "APPROVED") &&
    e.amountCents === amountCents &&
    dayDiff(e.day, ticketDay) <= 1,
  )
  return matches.length === 1 ? matches[0] : null
}

/** Clé UUID stable dérivée de la clé du chauffeur : le dépôt et la dépense rejouent ensemble. */
export function derivedKey(key: string, purpose: string): string {
  const h = createHash("sha256").update(`${purpose}:${key.toLowerCase()}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Titre et métadonnées du justificatif (document du camion). */
export function receiptDocumentBody(input: DriverTicketInput, driverName: string) {
  return {
    category: "EXPENSE_RECEIPT" as const,
    title: `Ticket carburant du ${input.day.split("-").reverse().join("/")}`.slice(0, 200),
    issuedOn: input.day,
    issuerName: input.station?.trim() || null,
    observations: `Photographié par ${driverName}. Montant ${normalizeDecimal(input.amount)} €${input.litres ? `, ${normalizeDecimal(input.litres)} L` : ""}${input.mileage ? `, compteur ${input.mileage} km` : ""}.`.slice(0, 2000),
  }
}

/** Création d'un plein « à valider » depuis le ticket. */
export function ticketCreateCommand(input: DriverTicketInput, documentVersionId: string, driverName: string) {
  return {
    action: "CREATE" as const,
    data: {
      category: "FUEL" as const,
      occurredAt: `${input.day}T12:00:00.000Z`,
      amount: normalizeDecimal(input.amount),
      currency: "EUR",
      litres: input.litres ? normalizeDecimal(input.litres) : null,
      mileageObservation: input.mileage ?? null,
      supplier: input.station?.trim() || null,
      documentVersionId,
      notes: `Ticket photographié par ${driverName}.`,
    },
  }
}

/** Complément du plein bancaire : tous les champs existants sont renvoyés (la correction remplace l'enregistrement). */
export function ticketCorrectCommand(expense: CandidateExpense, input: DriverTicketInput, documentVersionId: string, driverName: string) {
  const amount = (expense.amountCents / 100).toFixed(2)
  return {
    action: "CORRECT" as const,
    expenseId: expense.id,
    expectedRevision: expense.revision,
    reason: `Ticket photographié par ${driverName} : litres et justificatif ajoutés.`.slice(0, 2000),
    data: {
      category: "FUEL" as const,
      occurredAt: `${expense.day}T12:00:00.000Z`,
      amount,
      currency: "EUR",
      litres: input.litres ? normalizeDecimal(input.litres) : expense.litres,
      mileageObservation: input.mileage ?? expense.mileageObservation,
      supplier: expense.supplier,
      reference: expense.reference,
      documentVersionId,
      notes: [expense.notes?.replace(/\s*Ajoutez le ticket pour les litres\.?/, ""), `Ticket photographié par ${driverName}.`].filter(Boolean).join(" ").slice(0, 4000),
    },
  }
}
