/**
 * Lot I Planificator V2 : boutique de SIMULATION — règles PURES (aucun accès base, aucun paiement, aucune facture).
 *
 * - Commande interne : un client et 1 à 20 lignes (article, quantité entière de 1 à 999). Les prix, taux et libellés
 *   viennent TOUJOURS de l'article lu côté serveur, jamais du formulaire.
 * - Promotion : un code par commande, normalisé en majuscules, pourcentage de 0,01 % à 100 %, actif, et valable du
 *   premier au dernier jour de sa fenêtre (jours civils de Paris, bornes incluses).
 * - Montants en centimes (BigInt), moteur monétaire existant (`computeDocumentTotals`) : brut de ligne = quantité × prix
 *   HT ; remise de commande répartie ligne par ligne sur le HT (arrondi demi-supérieur au centime) ; TVA par ligne sur le
 *   HT net, arrondie demi-supérieur au centime ; totaux = sommes des lignes. Aucun nombre flottant.
 * - Idempotence : empreinte SHA-256 des paramètres normalisés (client, lignes, code) ; une même clé avec d'autres
 *   paramètres est refusée.
 */
import { createHash } from "node:crypto"
import { computeDocumentTotals, parsePercentToBp } from "@/lib/billing/money"

export const MAX_ORDER_LINES = 20
export const MAX_QUANTITY = 999
const ID = /^[A-Za-z0-9_-]{1,64}$/
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/
export const PROMO_CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/

export const SHOP_ERRORS = {
  notFound: "Élément introuvable.",
  client: "Client introuvable ou inactif.",
  noLine: "Ajoutez au moins une ligne (article et quantité).",
  tooManyLines: `Au plus ${MAX_ORDER_LINES} lignes par commande.`,
  quantity: `Quantité invalide : nombre entier de 1 à ${MAX_QUANTITY}.`,
  article: "Article introuvable ou inactif.",
  articlePrice: "Prix ou taux de TVA de l'article invalide pour la simulation.",
  promoFormat: "Code promotionnel invalide : 3 à 32 caractères, lettres, chiffres et tirets.",
  promoUnknown: "Code promotionnel inconnu.",
  promoInactive: "Code promotionnel inactif.",
  promoNotYet: "Code promotionnel pas encore valable.",
  promoExpired: "Code promotionnel expiré.",
  promoPercent: "Pourcentage invalide : de 0,01 à 100.",
  promoWindow: "Fenêtre de validité invalide : dates AAAA-MM-JJ, fin au plus tôt le jour du début.",
  promoExists: "Ce code promotionnel existe déjà.",
  idempotencyKey: "Formulaire expiré : rechargez la page avant d'enregistrer la commande.",
  idempotencyMismatch: "Cette commande a déjà été envoyée avec d'autres paramètres : rechargez la page pour une nouvelle commande.",
  amount: "Montant de la commande hors limites.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** Code saisi → code normalisé (espaces de bord retirés, majuscules) ; refus hors format. */
export function normalizePromoCode(raw: string): Plan<string> {
  const c = raw.trim().toUpperCase()
  return PROMO_CODE.test(c) ? { ok: true, value: c } : ko(SHOP_ERRORS.promoFormat)
}
/** Pourcentage saisi (« 10 », « 12,5 ») → points de base de 1 à 10 000. */
export function parsePromoPercent(raw: string): Plan<number> {
  try {
    const bp = parsePercentToBp(raw)
    return bp >= 1 && bp <= 10000 ? { ok: true, value: bp } : ko(SHOP_ERRORS.promoPercent)
  } catch {
    return ko(SHOP_ERRORS.promoPercent)
  }
}

export type PromoState = "VALID" | "INACTIVE" | "NOT_YET" | "EXPIRED"
/** État d'une promotion pour le jour civil `today` (minuit UTC du jour de Paris), bornes de la fenêtre incluses. */
export function promotionState(p: { active: boolean; validFrom: Date; validUntil: Date }, today: Date): PromoState {
  if (!p.active) return "INACTIVE"
  if (today.getTime() < p.validFrom.getTime()) return "NOT_YET"
  if (today.getTime() > p.validUntil.getTime()) return "EXPIRED"
  return "VALID"
}
export const PROMO_STATE_ERROR: Record<Exclude<PromoState, "VALID">, string> = {
  INACTIVE: SHOP_ERRORS.promoInactive, NOT_YET: SHOP_ERRORS.promoNotYet, EXPIRED: SHOP_ERRORS.promoExpired,
}

export interface OrderLineRequest { articleId: string; quantity: number }
export interface OrderRequest { clientId: string; lines: OrderLineRequest[]; promoCode: string | null }

/** Quantité saisie → entier de 1 à 999 (chiffres seulement, aucune troncature). */
export function parseQuantity(raw: string): Plan<number> {
  const s = raw.trim()
  if (!/^\d{1,3}$/.test(s)) return ko(SHOP_ERRORS.quantity)
  const q = Number(s)
  return q >= 1 && q <= MAX_QUANTITY ? { ok: true, value: q } : ko(SHOP_ERRORS.quantity)
}

/** Requête normalisée : identifiants bornés, 1 à 20 lignes, quantités entières bornées, code normalisé ou null. */
export function validateOrderRequest(input: { clientId: string; lines: { articleId: string; quantity: string }[]; promoCode: string }): Plan<OrderRequest> {
  if (!ID.test(input.clientId)) return ko(SHOP_ERRORS.client)
  const filled = input.lines.filter((l) => l.articleId.trim() !== "" || l.quantity.trim() !== "")
  if (filled.length === 0) return ko(SHOP_ERRORS.noLine)
  if (filled.length > MAX_ORDER_LINES) return ko(SHOP_ERRORS.tooManyLines)
  const lines: OrderLineRequest[] = []
  for (const l of filled) {
    const articleId = l.articleId.trim()
    if (!ID.test(articleId)) return ko(SHOP_ERRORS.article)
    const q = parseQuantity(l.quantity)
    if (!q.ok) return q
    lines.push({ articleId, quantity: q.value })
  }
  let promoCode: string | null = null
  if (input.promoCode.trim() !== "") {
    const c = normalizePromoCode(input.promoCode)
    if (!c.ok) return c
    promoCode = c.value
  }
  return { ok: true, value: { clientId: input.clientId, lines, promoCode } }
}

/** Empreinte de la requête normalisée (ordre des lignes conservé) : même clé + autre empreinte ⇒ refus. */
export function requestSha256(r: OrderRequest): string {
  const canonical = JSON.stringify({ clientId: r.clientId, lines: r.lines.map((l) => ({ articleId: l.articleId, quantity: l.quantity })), promoCode: r.promoCode })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/** Article figé au moment de la commande (lu côté serveur). */
export interface PricedLine { articleId: string; designation: string; unit: string; quantity: number; unitPriceCents: bigint; vatRateBp: number }
export interface ComputedOrderLine extends PricedLine { position: number; grossCents: bigint; discountCents: bigint; netCents: bigint; vatCents: bigint }
export interface ComputedOrder { lines: ComputedOrderLine[]; subtotalCents: bigint; discountCents: bigint; totalHTCents: bigint; totalVATCents: bigint; totalTTCCents: bigint }

/** Lignes et totaux d'une commande (moteur monétaire existant, remise de commande, TVA par ligne après remise). */
export function computeOrder(lines: readonly PricedLine[], promotionPercentBp: number): ComputedOrder {
  const t = computeDocumentTotals(
    lines.map((l) => ({ quantityHundredths: BigInt(l.quantity) * BigInt(100), unitPriceCents: l.unitPriceCents, discountBp: 0, vatRateBp: l.vatRateBp })),
    { globalDiscountBp: promotionPercentBp, vatReverseCharge: false },
  )
  const computed = lines.map((l, i) => {
    const c = t.lines[i]
    return { ...l, position: i + 1, grossCents: c.grossCents, discountCents: c.grossCents - c.netCents, netCents: c.netCents, vatCents: c.vatCents }
  })
  return { lines: computed, subtotalCents: t.subtotalCents, discountCents: t.globalDiscountCents, totalHTCents: t.totalHTCents, totalVATCents: t.totalVATCents, totalTTCCents: t.totalTTCCents }
}
