import { imprimerieTarget, type ImprimerieTarget } from "./production"

const printOrigins = {
  production: "https://printmanager-pro.onrender.com",
  recette: "https://printmanager-pr29-recette.onrender.com",
} satisfies Record<ImprimerieTarget, string>

export const BAT_STATUS_LABELS = {
  PENDING: "En attente",
  APPROVED: "Validé",
  REJECTED: "Refusé",
  EXPIRED: "Expiré",
} as const

export const PRODUCTION_STATUS_LABELS = {
  RECU: "Reçu",
  EN_PREPARATION: "En préparation",
  EN_COURS: "En cours",
  CONTROLE_QUALITE: "Contrôle qualité",
  PRET: "Prêt",
  LIVRE: "Livré",
  ANNULE: "Annulé",
} as const

export const INVOICE_STATUS_LABELS = {
  DRAFT: "Brouillon",
  SENT: "Envoyée",
  PARTIAL: "Partiellement réglée",
  PAID: "Réglée",
  OVERDUE: "En retard",
  CANCELLED: "Annulée",
} as const

type InvoiceSummary = { number: string; status: keyof typeof INVOICE_STATUS_LABELS }
type BatSummary = { number: string; status: keyof typeof BAT_STATUS_LABELS }
type ProductionOrderSummary = {
  number: string
  status: keyof typeof PRODUCTION_STATUS_LABELS
  deliveredAt: string | null
}
type ProductionOrderPayload = Pick<ProductionOrderSummary, "number" | "status"> & { deliveredAt?: unknown }
type QuoteSummary = {
  number: string
  status: string
  bat?: BatSummary | null
  invoice?: InvoiceSummary
  productionOrders?: ProductionOrderSummary[]
}
export type ImprimerieResult =
  | { state: "ready"; quote: QuoteSummary }
  | { state: "missing" | "unavailable" }

function isProductionOrderPayload(value: unknown): value is ProductionOrderPayload {
  if (typeof value !== "object" || value === null) return false
  const { number, status } = value as { number?: unknown; status?: unknown }
  return typeof number === "string" && number.trim().length > 0
    && typeof status === "string" && Object.hasOwn(PRODUCTION_STATUS_LABELS, status)
}

function isInvoiceSummary(value: unknown): value is InvoiceSummary {
  if (typeof value !== "object" || value === null) return false
  const { number, status } = value as { number?: unknown; status?: unknown }
  return typeof number === "string" && number.trim().length > 0
    && typeof status === "string" && Object.hasOwn(INVOICE_STATUS_LABELS, status)
}

function readDeliveryDate(value: unknown): string | null {
  if (typeof value !== "string") return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null
}

export async function readPrintManagerQuote(
  quoteNumber: string,
  token: string | null | undefined,
  invoiceRequestScope?: string,
  target = imprimerieTarget(),
): Promise<ImprimerieResult> {
  if (!token || !target || !Object.hasOwn(printOrigins, target)) return { state: "unavailable" }
  const invoiceScope = target === "production" ? invoiceRequestScope : undefined
  try {
    const response = await fetch(printOrigins[target] + "/api/integrations/imprimerie/devis/" + encodeURIComponent(quoteNumber), {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
        ...(invoiceScope ? { "X-Imprimerie-Invoice-Scope": invoiceScope } : {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 404) return { state: "missing" }
    if (!response.ok) return { state: "unavailable" }
    const quote = await response.json() as Partial<QuoteSummary>
    if (quote.number !== quoteNumber || typeof quote.status !== "string") {
      return { state: "unavailable" }
    }
    const summary: QuoteSummary = { number: quote.number, status: quote.status }
    const invoice = quote.invoice
    if (invoiceScope && isInvoiceSummary(invoice)) {
      summary.invoice = { number: invoice.number, status: invoice.status }
    }
    if (quote.bat === null) {
      summary.bat = null
    } else if (quote.bat && typeof quote.bat.number === "string" && quote.bat.number.trim()
      && typeof quote.bat.status === "string" && Object.hasOwn(BAT_STATUS_LABELS, quote.bat.status)) {
      summary.bat = { number: quote.bat.number, status: quote.bat.status }
    }
    const orders = quote.productionOrders
    if (Array.isArray(orders) && orders.every(isProductionOrderPayload)) {
      summary.productionOrders = orders.map(({ number, status, deliveredAt }) => ({
        number,
        status,
        deliveredAt: status === "LIVRE" ? readDeliveryDate(deliveredAt) : null,
      }))
    }
    return { state: "ready", quote: summary }
  } catch {
    return { state: "unavailable" }
  }
}
