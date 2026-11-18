/**
 * Pleins détectés dans les relevés bancaires importés (Comptabilité → Banque), proposés pour un camion.
 * Lecture seule : l'enregistrement passe par la commande de dépense existante (audit, idempotence,
 * statut « à valider »), déclenchée par l'utilisateur.
 */
import { createHash } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { z } from "zod"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession, type MileageSession } from "../mileage-access"
import { authorizeVehicleLocked } from "../vehicle-authority"
import {
  bankFuelExpenseCommand,
  bankLineIdempotencyKey,
  cardDigits,
  classifyCardSpend,
  learnCardTrucks,
  resolveFuelLines,
  type CardSpendCategory,
  type ResolvedFuelLine,
  type BankFuelLine,
  type FleetTour,
  type FuelResolution,
  type RecordedFuelExpense,
} from "./bank-fuel-domain"

export { bankFuelExpenseCommand }

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const bankFuelQuerySchema = z
  .object({ from: day, to: day })
  .strict()
  .refine((q) => q.to >= q.from && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366)

export interface BankFuelDeps { auth: () => Promise<MileageSession | null>; db: PrismaClient }

export interface BankFuelSuggestion {
  id: string
  day: string
  label: string
  amount: string
  card: string | null
  resolution: FuelResolution
  /** Matricule des camions cités par la résolution. */
  truckLabels: Record<string, string>
  idempotencyKey: string
}

export interface BankFuelResult {
  /** Pleins à ajouter à ce camion (rattachement sûr). */
  forTruck: BankFuelSuggestion[]
  /** Pleins non attribués dont ce camion est un candidat (ou sans aucune tournée ce jour-là). */
  toConfirm: BankFuelSuggestion[]
  /** Pleins du relevé déjà enregistrés sur ce camion. */
  recordedCount: number
  /** Aucun relevé importé sur la période : invite à importer le relevé mensuel. */
  statementsInPeriod: number
}

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 15_000 }
const civilDay = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
const utc = (s: string, days = 0) => new Date(Date.parse(`${s}T00:00:00.000Z`) + days * 86_400_000)

type Tx = Prisma.TransactionClient

/** Paiement carte hors carburant (péage, repas, hôtel) rattaché à un camion par sa carte. */
export interface CardSpendLine { id: string; day: string; label: string; amountCents: number; category: Exclude<CardSpendCategory, "FUEL">; truckId: string | null; card: string | null }

/**
 * Lecture commune (toute la flotte) : opérations carte de la période, cartes apprises sur 120 jours,
 * pleins résolus et autres frais carte rattachés à leur camion.
 */
export async function loadCompanyCardSpend(tx: Tx, companyId: string, timeZone: string, from: string, to: string) {
  const transactions = await tx.bankTransaction.findMany({
    where: {
      companyId,
      date: { gte: utc(from, -120), lte: utc(to) },
      amountCents: { lt: 0 },
      status: { not: "IGNORED" },
      OR: [{ collisionOfId: null }, { collisionResolution: "DISTINCT" }],
    },
    select: { id: true, date: true, label: true, amountCents: true, importId: true },
    orderBy: { date: "asc" },
    take: 5_000,
  })
  const categorized = transactions.flatMap((t) => {
    const amountCents = Number(t.amountCents)
    const category = classifyCardSpend(t.label, amountCents)
    return category ? [{ id: t.id, day: t.date.toISOString().slice(0, 10), label: t.label.slice(0, 200), amountCents, category }] : []
  })
  const fuelLines: BankFuelLine[] = categorized.filter((l) => l.category === "FUEL").map(({ category: _c, ...l }) => l)
  const statementsInPeriod = new Set(transactions.filter((t) => t.date >= utc(from)).map((t) => t.importId)).size

  const tours = await tx.vehicleTour.findMany({
    where: { companyId, status: { not: "CANCELLED" }, startsAt: { lt: utc(to, 2) }, endsAt: { gt: utc(from, -121) } },
    select: { truckId: true, startsAt: true, endsAt: true, stops: { select: { address: true } } },
    take: 2_000,
  })
  const fleetTours: FleetTour[] = tours.map((t) => ({
    truckId: t.truckId,
    startDay: civilDay(t.startsAt, timeZone),
    endDay: civilDay(new Date(t.endsAt.getTime() - 1), timeZone),
    stopAddresses: t.stops.map((s) => s.address),
  }))
  const expenses = await tx.vehicleExpense.findMany({
    where: { companyId, category: "FUEL", status: { in: ["PENDING", "APPROVED"] }, currency: "EUR", occurredAt: { gte: utc(from, -122), lt: utc(to, 3) } },
    select: { truckId: true, occurredAt: true, amount: true, reference: true },
    take: 5_000,
  })
  const recorded: RecordedFuelExpense[] = expenses.map((e) => ({
    truckId: e.truckId,
    day: civilDay(e.occurredAt, timeZone),
    amountCents: Math.round(Number(e.amount) * 100),
    reference: e.reference,
  }))
  const cards = learnCardTrucks(fuelLines, fleetTours, recorded)
  const inPeriod = (l: { day: string }) => l.day >= from && l.day <= to
  const fuel: ResolvedFuelLine[] = resolveFuelLines({ lines: fuelLines, tours: fleetTours, expenses: recorded }).filter(inPeriod)
  const otherSpend: CardSpendLine[] = categorized.filter((l) => l.category !== "FUEL" && inPeriod(l)).map((l) => {
    const card = cardDigits(l.label)
    return { ...l, category: l.category as CardSpendLine["category"], card, truckId: card ? cards.get(card) ?? null : null }
  })
  return { fuel, otherSpend, statementsInPeriod }
}

export async function readBankFuel(truckId: string, rawQuery: unknown, deps: BankFuelDeps): Promise<BankFuelResult> {
  const session = requireMileageSession(await deps.auth())
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.role)) throw new MileageDomainError("FORBIDDEN", 403)
  const parsed = bankFuelQuerySchema.safeParse(rawQuery)
  if (!parsed.success) throw new MileageDomainError("INVALID_PERIOD", 400)
  const { from, to } = parsed.data
  const companyId = session.companyId

  return deps.db.$transaction(async (tx) => {
    await authorizeVehicleLocked(tx, truckId, session, "READ")
    const settings = await tx.companySettings.findUnique({ where: { companyId }, select: { timezone: true } })
    const timeZone = settings?.timezone || "Europe/Paris"
    const { fuel: resolved, statementsInPeriod } = await loadCompanyCardSpend(tx, companyId, timeZone, from, to)

    const truckIds = new Set<string>()
    for (const l of resolved) {
      if (l.resolution.kind === "UNRESOLVED") l.resolution.candidates.forEach((c) => truckIds.add(c))
      else truckIds.add(l.resolution.truckId)
    }
    const trucks = truckIds.size
      ? await tx.truck.findMany({ where: { companyId, id: { in: [...truckIds] } }, select: { id: true, matricule: true } })
      : []
    const labels = Object.fromEntries(trucks.map((t) => [t.id, t.matricule]))
    return splitForTruck(resolved, truckId, companyId, labels, statementsInPeriod)
  }, txOptions)
}

export function splitForTruck(resolved: readonly ResolvedFuelLine[], truckId: string, companyId: string, labels: Record<string, string>, statementsInPeriod: number): BankFuelResult {
  const toSuggestion = (l: ResolvedFuelLine): BankFuelSuggestion => ({
    id: l.id,
    day: l.day,
    label: l.label,
    amount: (-l.amountCents / 100).toFixed(2),
    card: l.card,
    resolution: l.resolution,
    truckLabels: labels,
    idempotencyKey: bankLineIdempotencyKey(createHash("sha256").update(`bank-fuel:${companyId}:${truckId}:${l.id}`).digest("hex")),
  })
  const forTruck: BankFuelSuggestion[] = []
  const toConfirm: BankFuelSuggestion[] = []
  let recordedCount = 0
  for (const l of resolved) {
    const r = l.resolution
    if (r.kind === "RECORDED") { if (r.truckId === truckId) recordedCount++; continue }
    if (r.kind === "UNRESOLVED") { if (r.candidates.length === 0 || r.candidates.includes(truckId)) toConfirm.push(toSuggestion(l)); continue }
    if (r.truckId === truckId) forTruck.push(toSuggestion(l))
  }
  return { forTruck, toConfirm, recordedCount, statementsInPeriod }
}

/**
 * Enregistrement automatique, juste après l'import d'un relevé : seuls les pleins dont la carte est
 * reconnue (rattachement certain) deviennent des dépenses « à valider ». Les autres restent proposés.
 * Ne bloque jamais l'import : toute erreur est comptée, pas levée.
 */
export async function autoRecordBankFuel(deps: BankFuelDeps & { execute: (truckId: string, body: unknown, key: string, deps: BankFuelDeps) => Promise<unknown> }, now = new Date()): Promise<{ created: number; failed: number }> {
  const session = requireMileageSession(await deps.auth())
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.role)) return { created: 0, failed: 0 }
  const companyId = session.companyId
  const to = now.toISOString().slice(0, 10)
  const from = new Date(now.getTime() - 92 * 86_400_000).toISOString().slice(0, 10)
  const fuel = await deps.db.$transaction(async (tx) => {
    const settings = await tx.companySettings.findUnique({ where: { companyId }, select: { timezone: true } })
    return (await loadCompanyCardSpend(tx, companyId, settings?.timezone || "Europe/Paris", from, to)).fuel
  }, txOptions)
  let created = 0, failed = 0
  for (const l of fuel) {
    if (l.resolution.kind !== "CARD") continue
    const truckId = l.resolution.truckId
    const key = bankLineIdempotencyKey(createHash("sha256").update(`bank-fuel:${companyId}:${truckId}:${l.id}`).digest("hex"))
    try {
      await deps.execute(truckId, bankFuelExpenseCommand({ id: l.id, day: l.day, label: l.label, amount: (-l.amountCents / 100).toFixed(2), card: l.card }), key, deps)
      created++
    } catch {
      failed++
    }
  }
  return { created, failed }
}
