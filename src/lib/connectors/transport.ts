/**
 * Lot F Planificator V2 : transport des connecteurs. UN SEUL transport existe : la SIMULATION, un double fictif
 * déterministe en mémoire. Ce fichier n'importe aucun module réseau (ni fetch, ni http, ni socket) : un test statique
 * le vérifie, et un test d'exécution compte les appels réseau (zéro attendu).
 *
 * Toutes les données simulées sont marquées `fictitious: true` et ne désignent aucune personne ni entreprise réelle.
 */
import { ConnectorSourceError, isValidCursor, type SourceItem } from "@/lib/connectors/connectors.core"
import type { ConnectorKey } from "@/lib/connectors/catalog"

export interface FetchRequest { connectorKey: ConnectorKey; resource: string; cursor: string | null; limit: number }
export interface SourcePage { items: SourceItem[]; cursor: string; hasMore: boolean }
export interface ConnectorTransport { readonly kind: "SIMULATION"; fetchPage(req: FetchRequest): Promise<SourcePage> }

/** Taille du jeu fictif par ressource. */
export const SIMULATED_COUNT = 12
const pad = (n: number) => String(n).padStart(3, "0")

/** Élément fictif n° i (1…SIMULATED_COUNT) : ne dépend que du connecteur, de la ressource et du rang. */
export function simulatedItem(key: ConnectorKey, resource: string, i: number): SourceItem {
  const base = { fictitious: true as const }
  const day = `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`
  switch (`${key}/${resource}`) {
    case "shopify/orders": return { externalId: `fictif-order-${pad(i)}`, data: { ...base, number: `FICTIF-${1000 + i}`, customer: `Client fictif ${pad(i)}`, totalCents: 10_000 + i * 731, currency: "EUR", status: i % 4 === 0 ? "refunded" : "paid", orderedOn: day } }
    case "shopify/customers": return { externalId: `fictif-customer-${pad(i)}`, data: { ...base, name: `Client fictif ${pad(i)}`, email: `client${pad(i)}@exemple.invalid`, ordersCount: i % 5 } }
    case "stripe/payments": return { externalId: `fictif-payment-${pad(i)}`, data: { ...base, amountCents: 5_000 + i * 913, currency: "EUR", status: i % 6 === 0 ? "failed" : "succeeded", paidOn: day } }
    case "mailchimp/contacts": return { externalId: `fictif-contact-${pad(i)}`, data: { ...base, email: `contact${pad(i)}@exemple.invalid`, consent: i % 3 !== 0, subscribedOn: day } }
    case "meta_ads/campaign_stats":
    case "google_ads/campaign_stats": return { externalId: `fictif-${key}-camp-${pad(i)}`, data: { ...base, campaign: `Campagne fictive ${1 + (i % 3)}`, day, impressions: 1_000 + i * 57, clicks: 20 + i * 3, costCents: 1_500 + i * 211 } }
    case "slack/channels": return { externalId: `fictif-channel-${pad(i)}`, data: { ...base, name: `canal-fictif-${pad(i)}`, members: 2 + (i % 7) } }
    // v4 : métadonnées seulement (aucun contenu, aucun historique, aucun fichier, aucun envoi).
    case "chatgpt/conversations": return { externalId: `fictif-conversation-${pad(i)}`, data: { ...base, title: `Conversation de démonstration ${pad(i)}`, createdOn: day } }
    case "google_calendar/events": {
      // Début et fin explicites, à l'heure UTC pleine, fin = début + 2 h, le même jour (07:00 à 16:00 au plus).
      const hour = 7 + (i % 8)
      const h = (n: number) => String(n).padStart(2, "0")
      return { externalId: `fictif-event-${pad(i)}`, data: { ...base, title: `Intervention fictive ${pad(i)}`, startsAt: `${day}T${h(hour)}:00:00Z`, endsAt: `${day}T${h(hour + 2)}:00:00Z`, location: `Chantier fictif ${1 + (i % 4)}` } }
    }
    case "outlook/messages": return { externalId: `fictif-message-${pad(i)}`, data: { ...base, subject: `Consultation fictive ${pad(i)}`, from: `consultation${pad(i)}@exemple.invalid`, receivedOn: day, hasAttachments: i % 3 === 0 } }
    case "sharepoint/documents": {
      const fileType = (["pdf", "docx", "xlsx", "jpg"] as const)[i % 4]
      return { externalId: `fictif-document-${pad(i)}`, data: { ...base, name: `document-chantier-fictif-${pad(i)}.${fileType}`, fileType, worksite: `Chantier fictif ${1 + (i % 4)}`, modifiedOn: day } }
    }
    default: throw new ConnectorSourceError("SOURCE_ITEM_INVALID")
  }
}

/** Double fictif : pagination par rang (`seq:N` = N éléments déjà remis). */
export const simulationTransport: ConnectorTransport = Object.freeze({
  kind: "SIMULATION" as const,
  async fetchPage(req: FetchRequest): Promise<SourcePage> {
    let from = 0
    if (req.cursor !== null) {
      const m = isValidCursor(req.cursor) ? /^seq:(\d{1,6})$/.exec(req.cursor) : null
      if (!m) throw new ConnectorSourceError("WATERMARK_INVALID")
      from = Math.min(Number(m[1]), SIMULATED_COUNT)
    }
    const to = Math.min(from + Math.max(1, req.limit), SIMULATED_COUNT)
    const items: SourceItem[] = []
    for (let i = from + 1; i <= to; i++) items.push(simulatedItem(req.connectorKey, req.resource, i))
    return { items, cursor: `seq:${to}`, hasMore: to < SIMULATED_COUNT }
  },
})
