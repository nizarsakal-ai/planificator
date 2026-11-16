process.env.RESEND_API_KEY ??= "re_test_dummy"
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import {
  assessBookingGmailHealth,
  BOOKING_GMAIL_STALE_AFTER_MS,
} from "@/lib/booking/booking-gmail-health"

;(globalThis as { React?: typeof React }).React = React

const now = new Date("2026-11-16T21:00:00.000Z")
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }
const withRouter = (el: React.ReactElement) =>
  renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{el}</AppRouterContext.Provider>)

describe("assessBookingGmailHealth", () => {
  it("jeton rafraîchi récemment → ok", () => {
    const h = assessBookingGmailHealth({ tokenExpiry: new Date(now.getTime() + 30 * 60_000), scanEnabled: true, now })
    assert.equal(h.level, "ok")
  })
  it("expiré depuis moins de deux passages → ok (pas d'alerte sur un incident passager)", () => {
    const h = assessBookingGmailHealth({ tokenExpiry: new Date(now.getTime() - 90 * 60_000), scanEnabled: true, now })
    assert.equal(h.level, "ok")
  })
  it("expiré au-delà du seuil (refresh refusé : invalid_grant) → reconnexion requise", () => {
    const h = assessBookingGmailHealth({
      tokenExpiry: new Date(now.getTime() - BOOKING_GMAIL_STALE_AFTER_MS - 1),
      scanEnabled: true,
      now,
    })
    assert.equal(h.level, "error")
    assert.equal(h.label, "reconnexion requise")
  })
  it("cas réel 29/10 → 16/11 : jeton figé depuis 18 jours → erreur", () => {
    const h = assessBookingGmailHealth({ tokenExpiry: "2026-10-29T10:00:00.000Z", scanEnabled: true, now })
    assert.equal(h.level, "error")
  })
  it("scan désactivé → inactif, jamais d'alerte trompeuse", () => {
    const h = assessBookingGmailHealth({ tokenExpiry: "2026-10-29T10:00:00.000Z", scanEnabled: false, now })
    assert.equal(h.level, "inactive")
  })
})

describe("GmailConnectionCard — état de santé", () => {
  it("boîte coupée : alerte + bouton « Reconnecter Gmail »", async () => {
    const { GmailConnectionCard } = await import("@/components/parametres/GmailConnectionCard")
    const health = assessBookingGmailHealth({ tokenExpiry: "2026-10-29T10:00:00.000Z", scanEnabled: true, now })
    const html = withRouter(
      <GmailConnectionCard connection={{ gmailAddress: "booking@example.com", connectedAt: new Date("2026-10-29"), health }} />
    )
    assert.match(html, /reconnexion requise/)
    assert.match(html, /Reconnecter Gmail/)
    assert.match(html, /role="alert"/)
  })
  it("boîte saine : pas d'alerte", async () => {
    const { GmailConnectionCard } = await import("@/components/parametres/GmailConnectionCard")
    const health = assessBookingGmailHealth({ tokenExpiry: new Date(now.getTime() + 600_000), scanEnabled: true, now })
    const html = withRouter(
      <GmailConnectionCard connection={{ gmailAddress: "booking@example.com", connectedAt: now, health }} />
    )
    assert.doesNotMatch(html, /Reconnecter Gmail/)
    assert.doesNotMatch(html, /role="alert"/)
  })
})
