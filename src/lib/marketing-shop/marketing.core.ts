/**
 * Lot I Planificator V2 : marketing — règles PURES (laboratoire interne, données fictives, aucun envoi ni prestataire).
 *
 * - Source : canal d'une liste FERMÉE et nom (2 à 120 caractères, unique par société). Campagne : rattachée à une source
 *   de la même société, nom unique, dates facultatives (fin au plus tôt le jour du début).
 * - Consentement : portée unique « attribution marketing » ; jamais par défaut (aucune ligne = aucun consentement) ;
 *   octroi et retrait datés et attribués à leur auteur.
 * - Conversion : attribution EXPLICITE d'une commande boutique de la même société à une campagne ; au plus une par
 *   commande ; consentement en cours exigé au moment de l'attribution.
 * - Indicateurs (définitions affichées) : « commandes converties » = nombre de conversions de la campagne ;
 *   « montant HT net attribué » = somme des totaux HT après promotion des commandes converties, figés à l'attribution.
 *   Aucun taux n'est calculé : le module ne mesure aucun dénominateur (visites, contacts, envois).
 */
export type MarketingChannel = "WEBSITE" | "SOCIAL_MEDIA" | "EMAILING" | "PRINT" | "EVENT" | "REFERRAL" | "PARTNER" | "OTHER"
export const CHANNELS: readonly MarketingChannel[] = ["WEBSITE", "SOCIAL_MEDIA", "EMAILING", "PRINT", "EVENT", "REFERRAL", "PARTNER", "OTHER"]
export const CHANNEL_LABEL: Record<MarketingChannel, string> = {
  WEBSITE: "Site internet", SOCIAL_MEDIA: "Réseaux sociaux", EMAILING: "Campagne e-mail (déclarative)", PRINT: "Imprimé",
  EVENT: "Salon ou événement", REFERRAL: "Recommandation", PARTNER: "Partenaire", OTHER: "Autre",
}

export const MARKETING_ERRORS = {
  notFound: "Élément introuvable.",
  channel: "Canal invalide.",
  name: "Nom obligatoire (2 à 120 caractères).",
  sourceExists: "Une source porte déjà ce nom.",
  campaignExists: "Une campagne porte déjà ce nom.",
  dates: "Dates invalides : AAAA-MM-JJ, fin au plus tôt le jour du début.",
  source: "Source introuvable.",
  client: "Client introuvable ou inactif.",
  alreadyGranted: "Le consentement de ce client est déjà accordé.",
  notGranted: "Aucun consentement en cours pour ce client.",
  consentRequired: "Attribution refusée : le client n'a pas de consentement d'attribution marketing en cours.",
  order: "Commande introuvable.",
  campaign: "Campagne introuvable.",
  alreadyConverted: "Cette commande est déjà attribuée à une campagne.",
  changedMeanwhile: "Modifié entre-temps : rechargez la page puis réessayez.",
} as const

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string }
const ko = (error: string): { ok: false; error: string } => ({ ok: false, error })

export function validateChannel(raw: string): Plan<MarketingChannel> {
  return (CHANNELS as readonly string[]).includes(raw) ? { ok: true, value: raw as MarketingChannel } : ko(MARKETING_ERRORS.channel)
}
export function validateName(raw: string): Plan<string> {
  // eslint-disable-next-line no-control-regex
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  return n.length < 2 || n.length > 120 ? ko(MARKETING_ERRORS.name) : { ok: true, value: n }
}

/** Agrégat des conversions d'une campagne (nombre de commandes converties, somme des montants HT nets attribués). */
export interface ConversionFact { campaignId: string; convertedOrders: number; attributedHTCents: bigint }
export interface CampaignFact { id: string; name: string; sourceId: string }
export interface SourceFact { id: string; name: string; channel: MarketingChannel }
export interface CampaignIndicator { campaignId: string; name: string; sourceId: string; convertedOrders: number; attributedHTCents: bigint }
export interface SourceIndicator { sourceId: string; name: string; channel: MarketingChannel; convertedOrders: number; attributedHTCents: bigint }

/** Agrégat des conversions d'une source, calculé en base sur TOUTES les campagnes de la source (v2 de revue). */
export interface SourceConversionFact { sourceId: string; convertedOrders: number; attributedHTCents: bigint }

/**
 * Indicateurs (sommes exactes en centimes ; aucune division, aucun taux). v2 de revue : les deux agrégations sont
 * SÉPARÉES. Les lignes par campagne viennent de l'agrégat par campagne ; les totaux par source viennent d'un agrégat par
 * source calculé en base sur toutes les conversions de la société, et non de la liste (bornée) des campagnes affichées.
 */
export function computeIndicators(
  sources: readonly SourceFact[], campaigns: readonly CampaignFact[], campaignFacts: readonly ConversionFact[], sourceFacts: readonly SourceConversionFact[],
): { campaigns: CampaignIndicator[]; sources: SourceIndicator[] } {
  const byCampaign = new Map<string, CampaignIndicator>()
  for (const c of campaigns) byCampaign.set(c.id, { campaignId: c.id, name: c.name, sourceId: c.sourceId, convertedOrders: 0, attributedHTCents: BigInt(0) })
  for (const v of campaignFacts) {
    const k = byCampaign.get(v.campaignId)
    if (!k) continue
    k.convertedOrders += v.convertedOrders
    k.attributedHTCents += v.attributedHTCents
  }
  const bySource = new Map<string, SourceIndicator>()
  for (const s of sources) bySource.set(s.id, { sourceId: s.id, name: s.name, channel: s.channel, convertedOrders: 0, attributedHTCents: BigInt(0) })
  for (const f of sourceFacts) {
    const s = bySource.get(f.sourceId)
    if (!s) continue
    s.convertedOrders += f.convertedOrders
    s.attributedHTCents += f.attributedHTCents
  }
  return { campaigns: [...byCampaign.values()], sources: [...bySource.values()] }
}
