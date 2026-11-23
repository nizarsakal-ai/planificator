// Cloche de notifications hors réseau (correctif ciblé v3, séparé du lot D ; preuves R17x : getNotifications rejeté hors ligne alors que navigator.onLine restait vrai). Tests de COMPORTEMENT des fonctions utilisées par
// le composant : aucun appel hors réseau, reprise au retour du réseau, retrait de l'écouteur, erreur en ligne visible.
// Le câblage du composant est vérifié à part (il appelle ces fonctions, sans interception d'erreur).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { chargerSiEnLigne, echecReseau, ecouterRetourReseau, navigateurHorsLigne } from "@/components/notifications/notifications-reseau"

/** Reproduit l'effet du composant : chargement au montage, rechargement au retour du réseau, retrait au démontage. */
function monter(nav: { onLine?: boolean }, cible: EventTarget, charger: () => Promise<void>) {
  const load = () => chargerSiEnLigne(charger, nav)
  load()
  return ecouterRetourReseau(cible, () => { load() })
}

describe("cloche hors réseau : comportement", () => {
  it("hors réseau : aucun appel de l'action, ni au montage ni à l'ouverture", () => {
    let appels = 0
    const charger = async () => { appels++ }
    assert.equal(chargerSiEnLigne(charger, { onLine: false }), null)
    const demonter = monter({ onLine: false }, new EventTarget(), charger)
    assert.equal(appels, 0)
    demonter()
  })
  it("retour du réseau : un rechargement par événement online", () => {
    let appels = 0
    const nav = { onLine: false }, cible = new EventTarget()
    const demonter = monter(nav, cible, async () => { appels++ })
    nav.onLine = true; cible.dispatchEvent(new Event("online"))
    assert.equal(appels, 1)
    cible.dispatchEvent(new Event("online"))
    assert.equal(appels, 2)
    demonter()
  })
  it("démontage : l'écouteur est retiré, plus aucun rechargement", () => {
    let appels = 0
    const nav = { onLine: true }, cible = new EventTarget()
    const demonter = monter(nav, cible, async () => { appels++ })
    assert.equal(appels, 1)   // montage en ligne
    demonter()
    cible.dispatchEvent(new Event("online"))
    assert.equal(appels, 1)
  })
  it("v3 : échec RÉSEAU alors que le navigateur se dit en ligne (coupure, nouveau document) : absorbé, retenté au retour du réseau", async () => {
    for (const m of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      const p = chargerSiEnLigne(async () => { throw new TypeError(m) }, { onLine: true })
      assert.ok(p)
      await assert.doesNotReject(p)
    }
    let appels = 0
    const nav = { onLine: true }, cible = new EventTarget()
    const demonter = monter(nav, cible, async () => { appels++; if (appels === 1) throw new TypeError("Failed to fetch") })
    await new Promise((r) => setImmediate(r))
    cible.dispatchEvent(new Event("online"))
    assert.equal(appels, 2)
    demonter()
  })
  it("v3 : toute AUTRE erreur en ligne est rendue telle quelle (serveur, programmation, TypeError d'un autre message)", async () => {
    for (const erreur of [new Error("Erreur serveur 500"), new TypeError("Cannot read properties of undefined (reading 'map')"), new TypeError("failed to fetch "), Object.assign(new Error("Failed to fetch"), { name: "TypeError" })]) {
      const p = chargerSiEnLigne(async () => { throw erreur }, { onLine: true })
      assert.ok(p)
      await assert.rejects(p, (e) => e === erreur)
    }
  })
  it("v3 : échecReseau ne reconnaît que les TypeError de fetch aux messages connus", () => {
    assert.equal(echecReseau(new TypeError("Failed to fetch")), true)
    assert.equal(echecReseau(new Error("Failed to fetch")), false)
    assert.equal(echecReseau(new TypeError("x is not a function")), false)
    assert.equal(echecReseau("Failed to fetch"), false)
    assert.equal(echecReseau(undefined), false)
  })
  it("état réseau inconnu : traité comme en ligne (appel tenté)", () => {
    assert.equal(navigateurHorsLigne(undefined), false)
    assert.equal(navigateurHorsLigne(null), false)
    assert.equal(navigateurHorsLigne({}), false)
    let appels = 0
    chargerSiEnLigne(async () => { appels++ }, undefined)
    assert.equal(appels, 1)
  })
})

describe("NotificationBell : câblage", () => {
  const source = readFileSync(new URL("../../src/components/notifications/NotificationBell.tsx", import.meta.url), "utf8")
  it("le chargement passe par chargerSiEnLigne et l'effet rend le retrait de l'écouteur", () => {
    assert.match(source, /const load = \(\) => chargerSiEnLigne\(charger, /)
    assert.match(source, /return ecouterRetourReseau\(window, \(\) => \{ load\(\) \}\)/)
    assert.equal(source.match(/getNotifications\(\)/g)?.length, 1)
  })
  it("aucune interception d'erreur ajoutée dans le composant", () => {
    assert.ok(!/\bcatch\b/.test(source))
  })
})
