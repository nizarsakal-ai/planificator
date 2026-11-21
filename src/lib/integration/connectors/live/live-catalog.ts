/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8B : catalogue des connexions RÉELLES en lecture seule (Shopify, Mailchimp, Slack).
 *
 * Pour chaque service : les champs saisis par l'administrateur, leur validation stricte, la séparation entre le SECRET
 * (stocké chiffré dans le coffre PLATFORM_ENCRYPTED, jamais relu) et la configuration NON secrète (domaine de la boutique,
 * centre de données, audience), et les hôtes FIXES autorisés pour les appels (SECURITY-SPEC §24 : aucun endpoint libre).
 * LOT-8C : Google Agenda n'a AUCUN champ saisi (autorisation OAuth, voir `oauth/google-calendar-oauth.ts`) ; seul
 * l'agenda principal de l'utilisateur est lu (`calendarId = primary`).
 */
import type { LiveConnectorKey } from "@/lib/connectors/connectors.core"

export interface LiveField { name: string; label: string; secret: boolean; placeholder: string; help: string }
export interface LiveConfig { [k: string]: string }
export type ParsedCredentials = { ok: true; secret: string; config: LiveConfig } | { ok: false; error: string }

export const LIVE_FIELDS: Record<LiveConnectorKey, readonly LiveField[]> = {
  shopify: [
    { name: "shopDomain", label: "Domaine de la boutique", secret: false, placeholder: "ma-boutique.myshopify.com", help: "Adresse se terminant par .myshopify.com." },
    { name: "accessToken", label: "Jeton d'accès Admin API", secret: true, placeholder: "shpat_…", help: "Application personnalisée, droits en lecture : read_orders, read_customers." },
  ],
  mailchimp: [
    { name: "apiKey", label: "Clé d'API", secret: true, placeholder: "…-us21", help: "Mailchimp → Profil → Extras → Clés d'API." },
    { name: "audienceId", label: "Identifiant d'audience", secret: false, placeholder: "a1b2c3d4e5", help: "Audience → Paramètres → Nom et valeurs par défaut." },
  ],
  slack: [
    { name: "botToken", label: "Jeton de robot", secret: true, placeholder: "xoxb-…", help: "Application Slack, droit en lecture : channels:read. Aucun envoi." },
  ],
  google_calendar: [],
}

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/
const SHOPIFY_TOKEN = /^shp(?:at|ca|pa)_[A-Za-z0-9]{20,64}$/
const MAILCHIMP_KEY = /^[0-9a-f]{32}-(us[0-9]{1,3})$/
const MAILCHIMP_AUDIENCE = /^[0-9a-f]{10}$/
const SLACK_BOT = /^xoxb-[0-9A-Za-z-]{20,200}$/

const field = (form: Record<string, string | undefined>, k: string) => (form[k] ?? "").trim()

/** Valide la saisie ; renvoie le secret à chiffrer et la configuration non secrète, ou un message sans écho de la saisie. */
export function parseLiveCredentials(key: LiveConnectorKey, form: Record<string, string | undefined>): ParsedCredentials {
  switch (key) {
    case "shopify": {
      const shopDomain = field(form, "shopDomain").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "")
      const token = field(form, "accessToken")
      if (!SHOP_DOMAIN.test(shopDomain)) return { ok: false, error: "Domaine de boutique invalide : il doit se terminer par .myshopify.com." }
      if (!SHOPIFY_TOKEN.test(token)) return { ok: false, error: "Jeton d'accès Shopify invalide (format shpat_…)." }
      return { ok: true, secret: token, config: { shopDomain } }
    }
    case "mailchimp": {
      const apiKey = field(form, "apiKey")
      const audienceId = field(form, "audienceId").toLowerCase()
      const m = MAILCHIMP_KEY.exec(apiKey)
      if (!m) return { ok: false, error: "Clé d'API Mailchimp invalide (32 caractères suivis de -us…)." }
      if (!MAILCHIMP_AUDIENCE.test(audienceId)) return { ok: false, error: "Identifiant d'audience invalide (10 caractères)." }
      return { ok: true, secret: apiKey, config: { dataCenter: m[1], audienceId } }
    }
    case "slack": {
      const token = field(form, "botToken")
      if (!SLACK_BOT.test(token)) return { ok: false, error: "Jeton de robot Slack invalide (format xoxb-…)." }
      return { ok: true, secret: token, config: {} }
    }
    case "google_calendar":
      return { ok: false, error: "Google Agenda se connecte avec le bouton « Se connecter avec Google », sans saisie d'identifiant." }
  }
}

/** Configuration lue en base : revalidée avant tout appel (jamais d'hôte dérivé d'une valeur non contrôlée). */
export function readLiveConfig(key: LiveConnectorKey, raw: unknown): LiveConfig | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "")
  switch (key) {
    case "shopify": return SHOP_DOMAIN.test(str("shopDomain")) ? { shopDomain: str("shopDomain") } : null
    case "mailchimp": return /^us[0-9]{1,3}$/.test(str("dataCenter")) && MAILCHIMP_AUDIENCE.test(str("audienceId")) ? { dataCenter: str("dataCenter"), audienceId: str("audienceId") } : null
    case "slack": return {}
    case "google_calendar": return str("calendarId") === "primary" ? { calendarId: "primary" } : null
  }
}

/** Hôte unique autorisé pour un service, dérivé seulement d'une configuration validée (§24). */
export function liveHost(key: LiveConnectorKey, config: LiveConfig): string {
  switch (key) {
    case "shopify": return config.shopDomain
    case "mailchimp": return `${config.dataCenter}.api.mailchimp.com`
    case "slack": return "slack.com"
    case "google_calendar": return "www.googleapis.com"
  }
}
