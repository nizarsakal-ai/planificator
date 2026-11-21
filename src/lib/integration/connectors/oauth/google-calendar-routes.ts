/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-8C : gestionnaires des deux routes OAuth Google Agenda (dépendances injectées,
 * testables ; les routes Next ne sont que des enveloppes). Triple contrôle §13 : accès ADMIN de la société de session
 * (garde du centre de connecteurs), drapeau CONNECTOR_LIVE_ENABLED, client OAuth dédié configuré. La société vient
 * TOUJOURS de la session, jamais de l'adresse ; le retour refuse tout `state` qui n'a pas été émis pour cette session
 * (changement de société ou d'utilisateur pendant le flux ⇒ refus, §11).
 */
import type { PrismaClient } from "@prisma/client"
import { stockAccessMessage, type StockAccessResult } from "@/lib/stock/access"
import { isConnectorLiveEnabled } from "@/lib/connectors/connector-feature-flag"
import { ensureLiveConnection } from "@/lib/integration/connectors/live/live-connection.service"
import type { FetchLike } from "@/lib/integration/connectors/live/live-http"
import type { SecretProviderDeps } from "@/lib/integration/persistence/secret-provider.service"
import {
  GOOGLE_OAUTH_MESSAGES, OAUTH_COOKIE, backToConnectors, completeGoogleCalendarOAuth, readCookie, readGoogleCalendarOAuthConfig,
  redirectToGoogle, startGoogleCalendarOAuth, type Rng, type TokenPost,
} from "@/lib/integration/connectors/oauth/google-calendar-oauth"

export interface GoogleRouteDeps {
  access: () => Promise<StockAccessResult>
  db: PrismaClient
  env?: Record<string, string | undefined>
  now?: () => Date
  rng?: Rng
  post?: TokenPost
  fetch?: FetchLike
  secrets?: SecretProviderDeps
}

type Gate = { ok: true; ctx: { companyId: string; userId: string } } | { ok: false; response: Response }

async function gate(request: Request, d: GoogleRouteDeps): Promise<Gate> {
  const a = await d.access()
  if (!a.ok) {
    if (a.reason === "MODULE_DISABLED") return { ok: false, response: new Response(null, { status: 404 }) }
    if (a.reason === "UNAUTHENTICATED") return { ok: false, response: new Response(null, { status: 302, headers: { Location: new URL("/login", request.url).toString(), "Cache-Control": "private, no-store" } }) }
    return { ok: false, response: backToConnectors(request, false, stockAccessMessage(a.reason)) }
  }
  if (!isConnectorLiveEnabled(d.env)) return { ok: false, response: backToConnectors(request, false, GOOGLE_OAUTH_MESSAGES.liveDisabled) }
  return { ok: true, ctx: { companyId: a.context.companyId, userId: a.context.userId } }
}

/** GET …/connect : crée un état à usage unique et renvoie vers Google (cookie de corrélation posé). */
export async function handleGoogleCalendarConnect(request: Request, d: GoogleRouteDeps): Promise<Response> {
  const g = await gate(request, d)
  if (!g.ok) return g.response
  const cfg = readGoogleCalendarOAuthConfig(d.env)
  if (!cfg) return backToConnectors(request, false, GOOGLE_OAUTH_MESSAGES.notConfigured)
  const { authUrl, browserNonce } = await startGoogleCalendarOAuth(d.db, g.ctx, cfg, { now: d.now?.(), rng: d.rng })
  return redirectToGoogle(authUrl, browserNonce, new URL(cfg.redirectUri).protocol === "https:")
}

/** GET …/callback : état consommé, code échangé, autorisation chiffrée dans le coffre ; retour au centre de connecteurs. */
export async function handleGoogleCalendarCallback(request: Request, d: GoogleRouteDeps): Promise<Response> {
  const g = await gate(request, d)
  if (!g.ok) return g.response
  const cfg = readGoogleCalendarOAuthConfig(d.env)
  if (!cfg) return backToConnectors(request, false, GOOGLE_OAUTH_MESSAGES.notConfigured)
  const q = new URL(request.url).searchParams
  const now = d.now ?? (() => new Date())
  const r = await completeGoogleCalendarOAuth(d.db, g.ctx, cfg,
    { code: q.get("code"), state: q.get("state"), error: q.get("error"), browserNonce: readCookie(request, OAUTH_COOKIE) },
    { post: d.post, fetch: d.fetch, secrets: d.secrets, now, ensureConnection: (config) => ensureLiveConnection(d.db, g.ctx, "google_calendar", config, now()) })
  return backToConnectors(request, r.ok, r.message)
}
