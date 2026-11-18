/**
 * Ticket du chauffeur → facture fournisseur « à valider » (Comptabilité → Factures fournisseurs).
 *
 * Exécuté après la réponse au chauffeur, jamais bloquant : un échec laisse le ticket enregistré côté véhicule
 * et se lit dans les journaux. Réutilise le circuit existant des factures fournisseurs (stockage de la pièce
 * par empreinte, lecture OCR si activée, création PENDING tracée) : aucune écriture comptable ici, la
 * validation reste humaine.
 *
 * Règles :
 *   - le montant TTC vérifié par le chauffeur fait foi ; HT et TVA viennent de la lecture si elle est cohérente
 *     avec ce montant, sinon TVA calculée à 20 % et signalée « à vérifier » ;
 *   - pas de doublon : une facture non rejetée de même montant, à ± 1 jour, et de même SIRET, même numéro ou
 *     même fournisseur (mot commun) existe déjà ⇒ rien n'est créé (cas d'un ticket aussi scanné à la main) ;
 *   - la même photo déjà rattachée à une facture est refusée par le stockage (empreinte).
 */
import type { PrismaClient } from "@prisma/client"
import { createSupplierInvoice, extractSupplierInvoice, storeSupplierFile } from "@/lib/accounting/c5/supplier-invoice.service"
import type { OcrExtraction } from "@/lib/accounting/c5/ocr-provider"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import { withLifecycleAbort } from "@/lib/billing/lifecycle-abort"

export const DEFAULT_TICKET_VAT_RATE_BP = 2000
export const TICKET_SUPPLIER_CATEGORY = "deplacement"

export interface DriverTicketInvoiceInput {
  companyId: string
  userId: string
  driverName: string
  matricule: string
  kind: "FUEL" | "TOLL"
  day: string
  amountCents: number
  station: string | null
  /** Clé d'envoi du chauffeur : numéro de repli stable (rejeu sans doublon). */
  submissionKey: string
  file: { bytes: Uint8Array; filename: string }
}

export type DriverTicketInvoiceOutcome =
  | { outcome: "CREATED"; invoiceId: string }
  | { outcome: "ALREADY_EXISTS"; invoiceId: string }
  | { outcome: "SKIPPED"; reason: "ACCOUNTING_DISABLED" | "DUPLICATE_FILE" | "INVALID" ; detail?: string }

export interface ExistingInvoice { id: string; supplierName: string; siret: string | null; number: string; date: Date; totalTTCCents: bigint }

const words = (s: string) => new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))
const dayGap = (a: Date, b: string) => Math.abs(Date.parse(`${a.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

/** Facture déjà présente pour ce ticket (règle pure). */
export function findDuplicateInvoice(
  candidates: readonly ExistingInvoice[],
  ticket: { day: string; amountCents: number; siret: string | null; number: string | null; supplier: string | null },
): ExistingInvoice | null {
  const supplierWords = words(ticket.supplier ?? "")
  return candidates.find((c) => {
    if (Number(c.totalTTCCents) !== ticket.amountCents || dayGap(c.date, ticket.day) > 1) return false
    if (ticket.siret && c.siret) return ticket.siret === c.siret
    if (ticket.number && c.number && ticket.number.trim() === c.number.trim()) return true
    const theirs = words(c.supplierName)
    return [...supplierWords].some((w) => theirs.has(w) || [...theirs].some((t) => t.startsWith(w) || w.startsWith(t)))
  }) ?? null
}

/** HT / TVA : lecture si cohérente avec le TTC du chauffeur, sinon 20 % (signalé). */
export function ticketAmounts(amountCents: number, ocr: Pick<OcrExtraction, "totalHTCents" | "vatCents" | "vatRateBp"> | null) {
  const ttc = BigInt(amountCents)
  if (ocr?.totalHTCents != null && ocr.vatCents != null && ocr.totalHTCents + ocr.vatCents === ttc)
    return { totalHTCents: ocr.totalHTCents, vatCents: ocr.vatCents, totalTTCCents: ttc, vatRateBp: ocr.vatRateBp, vatComputed: false }
  const vat = BigInt(Math.round((amountCents * DEFAULT_TICKET_VAT_RATE_BP) / (10_000 + DEFAULT_TICKET_VAT_RATE_BP)))
  return { totalHTCents: ttc - vat, vatCents: vat, totalTTCCents: ttc, vatRateBp: DEFAULT_TICKET_VAT_RATE_BP, vatComputed: true }
}

export async function createInvoiceFromDriverTicket(input: DriverTicketInvoiceInput, deps: { db: PrismaClient; env?: NodeJS.ProcessEnv }): Promise<DriverTicketInvoiceOutcome> {
  if (!isAccountingModuleEnabled(deps.env ?? process.env)) return { outcome: "SKIPPED", reason: "ACCOUNTING_DISABLED" }
  const ctx = { companyId: input.companyId, userId: input.userId }
  const lo = new Date(Date.parse(`${input.day}T00:00:00Z`) - 86_400_000), hi = new Date(Date.parse(`${input.day}T00:00:00Z`) + 86_400_000)
  const candidates = () => deps.db.supplierInvoice.findMany({
    where: { companyId: input.companyId, status: { not: "REJECTED" }, totalTTCCents: BigInt(input.amountCents), date: { gte: lo, lte: hi } },
    select: { id: true, supplierName: true, siret: true, number: true, date: true, totalTTCCents: true },
    take: 50,
  })

  // 1. Déjà saisie (scan manuel, envoi précédent) : rien à créer.
  const fallbackNumber = `TICKET-${input.day.replaceAll("-", "")}-${input.submissionKey.replace(/-/g, "").slice(0, 8).toUpperCase()}`
  const early = findDuplicateInvoice(await candidates(), { day: input.day, amountCents: input.amountCents, siret: null, number: fallbackNumber, supplier: input.station })
  if (early) return { outcome: "ALREADY_EXISTS", invoiceId: early.id }

  // 2. Pièce : même circuit que le scan (signature binaire, taille, empreinte).
  const stored = await storeSupplierFile(deps.db, ctx, Buffer.from(input.file.bytes), input.file.filename)
  if (!stored.ok) return { outcome: "SKIPPED", reason: "DUPLICATE_FILE", detail: stored.error }

  // 3. Lecture (SIRET, numéro, HT/TVA) si l'OCR des factures est activé ; sinon valeurs du chauffeur.
  const read = await extractSupplierInvoice(deps.db, ctx, stored.value.fileId)
  const ocr = read.ok ? read.value : null
  const ttcMatches = ocr?.totalTTCCents == null || ocr.totalTTCCents === BigInt(input.amountCents)
  const siret = ttcMatches && ocr?.siret && /^\d{14}$/.test(ocr.siret) ? ocr.siret : null
  const number = (ttcMatches && ocr?.invoiceNumber?.trim()) ? ocr.invoiceNumber.trim().slice(0, 64) : fallbackNumber
  const supplierName = ((ttcMatches && ocr?.supplier?.trim()) || input.station?.trim() || (input.kind === "TOLL" ? "Péage" : "Station-service")).slice(0, 200)

  // 4. Doublon avec les informations lues (ex. même SIRET et même n° de ticket déjà scannés).
  const late = findDuplicateInvoice(await candidates(), { day: input.day, amountCents: input.amountCents, siret, number, supplier: supplierName })
  if (late) return { outcome: "ALREADY_EXISTS", invoiceId: late.id }

  const amounts = ticketAmounts(input.amountCents, ttcMatches ? ocr : null)
  const what = input.kind === "TOLL" ? "Ticket de péage" : "Ticket carburant"
  const notes = [
    `${what} photographié par ${input.driverName} (camion ${input.matricule}) depuis Planificator.`,
    amounts.vatComputed ? "TVA calculée à 20 % sur le montant TTC : à vérifier sur le ticket." : null,
    ocr && !ttcMatches ? "Le montant lu diffère du montant saisi par le chauffeur : vérifiez le ticket." : null,
  ].filter(Boolean).join(" ").slice(0, 2000)

  const created = await withLifecycleAbort(() => deps.db.$transaction(async (tx) => {
    const again = findDuplicateInvoice(
      await tx.supplierInvoice.findMany({
        where: { companyId: input.companyId, status: { not: "REJECTED" }, totalTTCCents: BigInt(input.amountCents), date: { gte: lo, lte: hi } },
        select: { id: true, supplierName: true, siret: true, number: true, date: true, totalTTCCents: true }, take: 50,
      }),
      { day: input.day, amountCents: input.amountCents, siret, number, supplier: supplierName },
    )
    if (again) return { ok: true as const, value: { id: again.id, existing: true } }
    const r = await createSupplierInvoice(tx, ctx, {
      supplierName, siret, number, date: new Date(`${input.day}T00:00:00.000Z`), dueDate: null,
      totalHTCents: amounts.totalHTCents, vatCents: amounts.vatCents, totalTTCCents: amounts.totalTTCCents, vatRateBp: amounts.vatRateBp,
      category: TICKET_SUPPLIER_CATEGORY, expenseAccountId: null, notes,
    }, { fileId: stored.value.fileId, ocr })
    return r.ok ? { ok: true as const, value: { id: r.value.id, existing: false } } : r
  }, { isolationLevel: "Serializable" }))
  if (!created.ok) return { outcome: "SKIPPED", reason: "INVALID", detail: created.error }
  return created.value.existing ? { outcome: "ALREADY_EXISTS", invoiceId: created.value.id } : { outcome: "CREATED", invoiceId: created.value.id }
}
