/** DG02 : relance de la cloche omise SEULEMENT sur /dashboard avec next-pwa actif (rechargement déjà installé). */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { rechargementPwaSurDashboard } from "@/components/notifications/notifications-reseau"

describe("DG02 : rechargement PWA sur /dashboard", () => {
  it("vrai uniquement avec window.workbox ET /dashboard exact", () => {
    assert.equal(rechargementPwaSurDashboard({ workbox: {}, location: { pathname: "/dashboard" } }), true)
    for (const w of [null, undefined, {}, { location: { pathname: "/dashboard" } }, { workbox: null, location: { pathname: "/dashboard" } },
      { workbox: {}, location: { pathname: "/reserves" } }, { workbox: {}, location: { pathname: "/dashboard/x" } }, { workbox: {}, location: { pathname: "/" } }])
      assert.equal(rechargementPwaSurDashboard(w), false, JSON.stringify(w))
  })
  it("couplage verrouillé : reloadOnOnline reste true ; la cloche ne court-circuite que le rappel online", () => {
    assert.match(readFileSync("next.config.ts", "utf8"), /reloadOnOnline:\s*true/, "si ce réglage change, retirer la condition DG02 de la cloche")
    const bell = readFileSync("src/components/notifications/NotificationBell.tsx", "utf8")
    assert.ok(bell.includes("return ecouterRetourReseau(window, () => { if (rechargementPwaSurDashboard(window)) return; load() })"))
    assert.equal(bell.split("rechargementPwaSurDashboard(").length - 1, 1, "aucun autre chemin conditionné")
  })
})
