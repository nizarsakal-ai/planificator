// ═══════════════════════════════════════════════════════════════════════════
// 21/11/2026 — Bon de LIVRAISON créé depuis un devis accepté, une facture émise ou un bon de commande client actif.
// Les désignations, unités et quantités commandées sont recopiées de la source ; la quantité livrée est saisie ligne par ligne
// (livraison partielle possible : plusieurs bons par source). Aucun prix sur un bon de livraison.
// Réception : nom et date du destinataire (statut DELIVERED, contrôlé en base). Annulation datée, jamais de suppression.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma, PrismaClient } from "@prisma/client"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { MoneyError, decimalToCents, hundredthsToDecimalString, parseQuantityToHundredths } from "@/lib/billing/money"
import type { CommercialContext } from "./client-order.service"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export type DeliverySourceType = "QUOTE" | "INVOICE" | "CLIENT_ORDER"

export const DELIVERY_ERRORS = {
  sourceNotFound: "Document d'origine introuvable.",
  quoteNotAccepted: "Seul un devis accepté (ou converti) peut être livré.",
  invoiceNotIssued: "Seule une facture émise (hors avoir et brouillon) peut être livrée.",
  orderCancelled: "Ce bon de commande est annulé.",
  noLines: "Le document d'origine ne comporte aucune ligne à livrer.",
  quantityInvalid: "Quantité livrée invalide (nombre positif, deux décimales au plus).",
  quantityCount: "Le nombre de quantités saisies ne correspond pas aux lignes du document d'origine.",
  nothingDelivered: "Au moins une ligne doit avoir une quantité livrée supérieure à zéro.",
  notFound: "Bon de livraison introuvable.",
  notIssued: "Seul un bon de livraison en attente peut être modifié (réception ou annulation).",
  receiverMissing: "Nom du destinataire obligatoire.",
} as const

interface SourceLine { designation: string; description: string | null; unit: string; quantity: Prisma.Decimal }
interface Source { type: DeliverySourceType; id: string; label: string; clientId: string; worksiteId: string; clientDeliveryAddress: string | null; preferredAddress: string | null; lines: SourceLine[] }

const lineSelect = { orderBy: { position: "asc" as const }, select: { designation: true, description: true, unit: true, quantity: true } }

async function loadSource(tx: Tx | Db, companyId: string, type: DeliverySourceType, id: string): Promise<LifecycleResult<Source>> {
  if (type === "QUOTE") {
    const q = await tx.quote.findFirst({ where: { id, companyId }, select: { id: true, number: true, status: true, clientId: true, worksiteId: true, client: { select: { deliveryAddress: true } }, lines: lineSelect } })
    if (!q) return { ok: false, error: DELIVERY_ERRORS.sourceNotFound }
    if (q.status !== "ACCEPTED" && q.status !== "CONVERTED") return { ok: false, error: DELIVERY_ERRORS.quoteNotAccepted }
    return { ok: true, value: { type, id: q.id, label: `devis ${q.number}`, clientId: q.clientId, worksiteId: q.worksiteId, clientDeliveryAddress: q.client.deliveryAddress, preferredAddress: null, lines: q.lines } }
  }
  if (type === "INVOICE") {
    const inv = await tx.invoice.findFirst({ where: { id, companyId }, select: { id: true, number: true, status: true, kind: true, clientId: true, worksiteId: true, deliveryAddress: true, client: { select: { deliveryAddress: true } }, lines: { ...lineSelect, where: { deductsDepositId: null } } } })
    if (!inv) return { ok: false, error: DELIVERY_ERRORS.sourceNotFound }
    if (inv.kind === "CREDIT_NOTE" || inv.status === "DRAFT" || inv.status === "CANCELLED") return { ok: false, error: DELIVERY_ERRORS.invoiceNotIssued }
    return { ok: true, value: { type, id: inv.id, label: `facture ${inv.number}`, clientId: inv.clientId, worksiteId: inv.worksiteId, clientDeliveryAddress: inv.client.deliveryAddress, preferredAddress: inv.deliveryAddress, lines: inv.lines } }
  }
  const o = await tx.clientOrder.findFirst({ where: { id, companyId }, select: { id: true, number: true, status: true, clientId: true, worksiteId: true, deliveryAddress: true, client: { select: { deliveryAddress: true } }, lines: lineSelect } })
  if (!o) return { ok: false, error: DELIVERY_ERRORS.sourceNotFound }
  if (o.status === "CANCELLED") return { ok: false, error: DELIVERY_ERRORS.orderCancelled }
  return { ok: true, value: { type, id: o.id, label: `bon de commande ${o.number}`, clientId: o.clientId, worksiteId: o.worksiteId, clientDeliveryAddress: o.client.deliveryAddress, preferredAddress: o.deliveryAddress, lines: o.lines } }
}

/** Lignes proposées dans le formulaire de création (lecture seule, bornée à la société). */
export async function deliverySourcePreview(db: Db, companyId: string, type: DeliverySourceType, id: string) {
  const s = await loadSource(db, companyId, type, id)
  if (!s.ok) return s
  return { ok: true as const, value: { label: s.value.label, defaultAddress: s.value.preferredAddress ?? s.value.clientDeliveryAddress ?? "", lines: s.value.lines.map((l) => ({ designation: l.designation, unit: l.unit, quantity: formatQuantityFr(l.quantity) })) } }
}

/** Quantité au format français sans zéros inutiles : 4 ; 1,5 ; 0,25 ; 10. */
export function formatQuantityFr(q: { toFixed(n: number): string }): string {
  return q.toFixed(2).replace(/\.(\d*?)0+$/, ".$1").replace(/\.$/, "").replace(".", ",")
}

/** Quantités livrées saisies (chaînes) → centièmes ; pur et testable. Vide ⇒ quantité commandée. */
export function parseDeliveredQuantities(raw: readonly string[], ordered: readonly bigint[]): LifecycleResult<bigint[]> {
  if (raw.length !== ordered.length) return { ok: false, error: DELIVERY_ERRORS.quantityCount }
  const out: bigint[] = []
  for (const [i, r] of raw.entries()) {
    if (r.trim() === "") { out.push(ordered[i]); continue }
    try { out.push(parseQuantityToHundredths(r)) } catch (e) { if (e instanceof MoneyError) return { ok: false, error: `Ligne ${i + 1} : ${DELIVERY_ERRORS.quantityInvalid}` }; throw e }
  }
  if (!out.some((q) => q > BigInt(0))) return { ok: false, error: DELIVERY_ERRORS.nothingDelivered }
  return { ok: true, value: out }
}

export interface DeliveryNoteInput { deliveryDate: Date; deliveryAddress: string | null; notes: string | null; delivered: string[] }

export async function createDeliveryNote(db: Db, ctx: CommercialContext, type: DeliverySourceType, sourceId: string, input: DeliveryNoteInput): Promise<LifecycleResult<{ id: string; number: string }>> {
  return db.$transaction(async (tx) => {
    const src = await loadSource(tx, ctx.companyId, type, sourceId)
    if (!src.ok) return src
    const s = src.value
    if (s.lines.length === 0) return { ok: false as const, error: DELIVERY_ERRORS.noLines }
    const ordered = s.lines.map((l) => decimalToCents(l.quantity))
    const q = parseDeliveredQuantities(input.delivered, ordered)
    if (!q.ok) return q
    const number = await nextDocumentNumber(tx, ctx.companyId, "DELIVERY_NOTE")
    const note = await tx.deliveryNote.create({
      data: {
        companyId: ctx.companyId, number, sourceType: type,
        quoteId: type === "QUOTE" ? s.id : null, invoiceId: type === "INVOICE" ? s.id : null, clientOrderId: type === "CLIENT_ORDER" ? s.id : null,
        clientId: s.clientId, worksiteId: s.worksiteId, deliveryDate: input.deliveryDate,
        deliveryAddress: input.deliveryAddress ?? s.preferredAddress ?? s.clientDeliveryAddress ?? null, notes: input.notes, createdById: ctx.userId,
        lines: { create: s.lines.map((l, i) => ({ position: i, designation: l.designation, description: l.description, unit: l.unit, quantityOrdered: hundredthsToDecimalString(ordered[i]), quantityDelivered: hundredthsToDecimalString(q.value[i]) })) },
      },
      select: { id: true, number: true },
    })
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "DeliveryNote", entityId: note.id, detail: `Bon de livraison ${note.number} créé depuis le ${s.label}`, newValue: { sourceType: type, sourceId: s.id, lines: s.lines.length } } })
    return { ok: true as const, value: note }
  })
}

export async function recordDeliveryReceipt(db: Db, ctx: CommercialContext, noteId: string, receivedByName: string, receivedAt: Date): Promise<LifecycleResult> {
  const name = receivedByName.trim()
  if (!name) return { ok: false, error: DELIVERY_ERRORS.receiverMissing }
  return db.$transaction(async (tx) => {
    const n = await tx.deliveryNote.findFirst({ where: { id: noteId, companyId: ctx.companyId }, select: { id: true, number: true, status: true } })
    if (!n) return { ok: false as const, error: DELIVERY_ERRORS.notFound }
    const u = await tx.deliveryNote.updateMany({ where: { id: n.id, companyId: ctx.companyId, status: "ISSUED" }, data: { status: "DELIVERED", receivedByName: name.slice(0, 120), receivedAt } })
    if (u.count !== 1) return { ok: false as const, error: DELIVERY_ERRORS.notIssued }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "DeliveryNote", entityId: n.id, detail: `Bon de livraison ${n.number} : réception par ${name}`, oldValue: { status: "ISSUED" }, newValue: { status: "DELIVERED" } } })
    return { ok: true as const, value: undefined }
  })
}

export async function cancelDeliveryNote(db: Db, ctx: CommercialContext, noteId: string, now: Date): Promise<LifecycleResult> {
  return db.$transaction(async (tx) => {
    const n = await tx.deliveryNote.findFirst({ where: { id: noteId, companyId: ctx.companyId }, select: { id: true, number: true } })
    if (!n) return { ok: false as const, error: DELIVERY_ERRORS.notFound }
    const u = await tx.deliveryNote.updateMany({ where: { id: n.id, companyId: ctx.companyId, status: "ISSUED" }, data: { status: "CANCELLED", cancelledAt: now } })
    if (u.count !== 1) return { ok: false as const, error: DELIVERY_ERRORS.notIssued }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "DeliveryNote", entityId: n.id, detail: `Bon de livraison ${n.number} annulé`, oldValue: { status: "ISSUED" }, newValue: { status: "CANCELLED" } } })
    return { ok: true as const, value: undefined }
  })
}

export async function listDeliveryNotes(db: Db, companyId: string, page = 1) {
  const pageSize = 50
  const [total, rows] = await Promise.all([
    db.deliveryNote.count({ where: { companyId } }),
    db.deliveryNote.findMany({
      where: { companyId }, orderBy: [{ deliveryDate: "desc" }, { number: "desc" }], skip: (Math.max(1, page) - 1) * pageSize, take: pageSize,
      select: { id: true, number: true, status: true, deliveryDate: true, sourceType: true, client: { select: { name: true } }, worksite: { select: { name: true } }, quote: { select: { number: true } }, invoice: { select: { number: true } }, clientOrder: { select: { number: true } } },
    }),
  ])
  return { total, rows, page: Math.max(1, page), pageSize }
}

export async function getDeliveryNote(db: Db, companyId: string, id: string) {
  return db.deliveryNote.findFirst({
    where: { id, companyId },
    select: {
      id: true, number: true, status: true, sourceType: true, deliveryDate: true, deliveryAddress: true, notes: true, receivedByName: true, receivedAt: true, cancelledAt: true,
      client: { select: { id: true, name: true } }, worksite: { select: { id: true, name: true } },
      quote: { select: { id: true, number: true } }, invoice: { select: { id: true, number: true } }, clientOrder: { select: { id: true, number: true } },
      lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantityOrdered: true, quantityDelivered: true } },
    },
  })
}
