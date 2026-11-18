/**
 * Ticket de carburant du chauffeur : camions attribués, lecture du ticket, dépôt du justificatif et
 * enregistrement du plein. Réutilise les services existants (stockage privé, lecture locale, commande de
 * dépense idempotente et auditée) avec l'autorité « chauffeur », limitée à son camion et aux justificatifs.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { MileageDomainError } from "../mileage-domain"
import { uploadVehicleDocumentAs, type DocumentFileInput, type DocumentServiceDeps } from "./document-service"
import { recognizeVehicleDocument, type DocumentRecognitionDeps } from "./document-recognition-service"
import { isVehicleDocumentRecognitionEnabled } from "./document-recognition-domain"
import { executeExpenseCommand } from "./expense-service"
import { validateVehicleExpenseDocument } from "./integration-bridges"
import { expenseEnabled } from "./expense-domain"
import { createInvoiceFromDriverTicket } from "./driver-ticket-supplier-invoice"
import { authorizeDriverReceipt, driverSessionFrom, findDriverTrucks, type DriverSession } from "./driver-receipt-authority"
import {
  derivedKey,
  driverTicketSchema,
  findBankExpenseToComplete,
  receiptDocumentBody,
  ticketCorrectCommand,
  ticketCreateCommand,
  ticketDayAllowed,
  toCents,
  type CandidateExpense,
} from "./driver-fuel-ticket-domain"

type RawSession = Parameters<typeof driverSessionFrom>[0]

export interface DriverTicketDeps {
  auth: () => Promise<RawSession>
  db: PrismaClient
  storage: DocumentServiceDeps["storage"]
  env?: NodeJS.ProcessEnv
  /** Injection pour les tests (lecteur de ticket). */
  read?: DocumentRecognitionDeps["read"]
  /** Tâche après la réponse (`after` de Next) : facture fournisseur « à valider » créée depuis le ticket. */
  afterResponse?: (task: () => Promise<void>) => void
}

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 15_000 }
const civilDay = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)

async function driverSession(deps: DriverTicketDeps): Promise<DriverSession> {
  if (!expenseEnabled()) throw new MileageDomainError("V3_DISABLED", 404)
  return driverSessionFrom(await deps.auth())
}

/** Camions dont l'utilisateur est le chauffeur attitré, et lecture automatique disponible ou non. */
export async function readMyTrucks(deps: DriverTicketDeps) {
  const session = await driverSession(deps)
  const trucks = await deps.db.$transaction((tx) => findDriverTrucks(tx, session), txOptions)
  return { trucks, recognitionEnabled: isVehicleDocumentRecognitionEnabled(deps.env ?? process.env) }
}

/** Lecture du ticket (aucune écriture) : montant, litres, date, station proposés au chauffeur. */
export async function recognizeDriverTicket(truckId: string, file: DocumentFileInput, deps: DriverTicketDeps) {
  const session = await driverSession(deps)
  const proposal = await recognizeVehicleDocument(
    truckId,
    { category: "EXPENSE_RECEIPT" },
    file,
    { auth: async () => null, db: deps.db, storage: deps.storage, env: deps.env, ...(deps.read ? { read: deps.read } : {}) },
    { authorize: (tx) => authorizeDriverReceipt(tx, truckId, session) },
  )
  const e = proposal.expense
  const pick = <T,>(f: { value: T; confidence: string } | undefined) => (f ? { value: f.value, sure: f.confidence === "READ" } : null)
  return {
    readable: proposal.reading.status === "TEXT_LAYER" || proposal.reading.status === "OCR",
    fuel: e?.fuel ?? false,
    refund: e?.refund === true,
    amount: e?.currency.status === "READ" && e.currency.value === "EUR" ? pick(e.amount) : null,
    litres: pick(e?.litres),
    day: pick(e?.date),
    station: pick(e?.supplier),
    mileage: pick(e?.mileage),
  }
}

export interface DriverTicketResult { outcome: "COMPLETED_BANK_EXPENSE" | "CREATED"; expenseId: string; replayed: boolean }

/** Dépôt du ticket comme justificatif, puis plein complété (relevé bancaire) ou créé « à valider ». */
export async function submitDriverTicket(rawInput: unknown, file: DocumentFileInput, key: string | null, deps: DriverTicketDeps): Promise<DriverTicketResult> {
  const session = await driverSession(deps)
  const parsed = driverTicketSchema.safeParse(rawInput)
  if (!parsed.success || !key) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const input = parsed.data
  if (!(toCents(input.amount) > 0)) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  const truckId = input.truckId

  // 1. Autorité, date et nom du chauffeur relus avant tout dépôt (aucun octet stocké si refus).
  const ctx = await deps.db.$transaction(async (tx) => {
    const { actor, truck } = await authorizeDriverReceipt(tx, truckId, session)
    const settings = await tx.companySettings.findUnique({ where: { companyId: session.companyId }, select: { timezone: true } })
    const timeZone = settings?.timezone || "Europe/Paris"
    return { driverName: actor.name?.trim() || "le chauffeur", matricule: truck.matricule, timeZone, today: civilDay(new Date(), timeZone) }
  }, txOptions)
  if (!ticketDayAllowed(input.day, ctx.today)) throw new MileageDomainError("TICKET_DATE_INVALID", 400)

  // Rejeu (réseau coupé après l'envoi) : la même clé renvoie le résultat déjà enregistré, sans recalcul.
  const expenseKey = derivedKey(key, "driver-ticket-expense")
  const prior = await deps.db.vehicleExpenseCommand.findFirst({
    where: { companyId: session.companyId, truckId, idempotencyKey: expenseKey.toLowerCase(), actorId: session.userId },
    select: { action: true, expenseId: true },
  })
  if (prior) return { outcome: prior.action === "CORRECT" ? "COMPLETED_BANK_EXPENSE" : "CREATED", expenseId: prior.expenseId ?? "", replayed: true }

  // 2. Justificatif comptable : document privé EXPENSE_RECEIPT du camion.
  const documentAuthority = { session, authorize: (tx: Prisma.TransactionClient) => authorizeDriverReceipt(tx, truckId, session) }
  const uploaded = await uploadVehicleDocumentAs(
    truckId,
    receiptDocumentBody(input, ctx.driverName),
    file,
    derivedKey(key, "driver-ticket-document"),
    { auth: async () => null, db: deps.db, storage: deps.storage, env: deps.env },
    documentAuthority,
  )
  const documentVersionId = uploaded.receipt.versionId

  // 3. Plein bancaire à compléter ?
  const amountCents = toCents(input.amount)
  const candidates: CandidateExpense[] = await deps.db.$transaction(async (tx) => {
    await authorizeDriverReceipt(tx, truckId, session)
    const lo = new Date(Date.parse(`${input.day}T00:00:00Z`) - 2 * 86_400_000)
    const hi = new Date(Date.parse(`${input.day}T00:00:00Z`) + 3 * 86_400_000)
    const rows = await tx.vehicleExpense.findMany({
      where: { companyId: session.companyId, truckId, category: "FUEL", reference: { startsWith: "BANQUE:" }, documentVersionId: null, occurredAt: { gte: lo, lt: hi } },
      take: 50,
    })
    return rows.map((r) => ({
      id: r.id, revision: r.revision, day: civilDay(r.occurredAt, ctx.timeZone), amountCents: Math.round(Number(r.amount) * 100), currency: r.currency,
      reference: r.reference, supplier: r.supplier, notes: r.notes, litres: r.litres === null ? null : r.litres.toString(),
      mileageObservation: r.mileageObservation, documentVersionId: r.documentVersionId, status: r.status,
    }))
  }, txOptions)
  // Péage : jamais de plein bancaire à compléter (les péages du relevé sont rapprochés dans les coûts par chantier).
  const bank = input.kind === "TOLL" ? null : findBankExpenseToComplete(candidates, amountCents, input.day)
  const command = bank ? ticketCorrectCommand(bank, input, documentVersionId, ctx.driverName) : ticketCreateCommand(input, documentVersionId, ctx.driverName)

  // 4. Dépense : création d'un plein, ou complément de CE plein bancaire précis, rien d'autre.
  const result = await executeExpenseCommand(
    truckId,
    command,
    expenseKey,
    { auth: async () => null, db: deps.db, validateDocumentVersion: validateVehicleExpenseDocument },
    {
      session,
      authorize: async (tx, action) => {
        const authorized = await authorizeDriverReceipt(tx, truckId, session)
        if (action === "CREATE") return authorized
        if (action === "CORRECT" && bank) {
          const target = await tx.vehicleExpense.findFirst({ where: { id: bank.id, companyId: session.companyId, truckId, category: "FUEL", reference: { startsWith: "BANQUE:" } }, select: { id: true } })
          if (target) return authorized
        }
        throw new MileageDomainError("FORBIDDEN", 403)
      },
    },
  )
  const expense = result.expense as { id?: string } | null
  // Comptabilité : la même pièce devient une facture fournisseur « à valider » (après la réponse, jamais bloquant).
  if (!result.replayed && deps.afterResponse) {
    const invoiceInput = {
      companyId: session.companyId, userId: session.userId, driverName: ctx.driverName, matricule: ctx.matricule,
      kind: input.kind ?? "FUEL", day: input.day, amountCents, station: input.station?.trim() || null,
      submissionKey: key, file: { bytes: file.bytes, filename: file.filename },
    } as const
    deps.afterResponse(async () => {
      try {
        const r = await createInvoiceFromDriverTicket(invoiceInput, { db: deps.db, env: deps.env })
        console.info("[vehicle-fuel-ticket] supplier invoice", { outcome: r.outcome, ...(r.outcome === "SKIPPED" ? { reason: r.reason } : {}) })
      } catch (error) {
        console.error("[vehicle-fuel-ticket] supplier invoice failed", { name: error instanceof Error ? error.name : typeof error })
      }
    })
  }
  return { outcome: bank ? "COMPLETED_BANK_EXPENSE" : "CREATED", expenseId: expense?.id ?? bank?.id ?? "", replayed: result.replayed }
}
