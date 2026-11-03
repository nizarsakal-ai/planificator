/**
 * Apparence — préférence clair / sombre / système, clé de stockage par utilisateur et script anti-flash.
 * Exécution : `node --import tsx --test tests/navigation/appearance.test.ts`.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { runInNewContext } from "node:vm"
import {
  APPEARANCE_LABELS, APPEARANCE_PREFERENCES, DEFAULT_APPEARANCE,
  appearanceBootScript, appearanceStorageKey, parseAppearance, resolveTheme,
} from "@/lib/appearance/appearance"

describe("apparence — préférence", () => {
  it("trois choix dans l'ordre, libellés français, défaut = suivre l'appareil", () => {
    assert.deepEqual(APPEARANCE_PREFERENCES, ["light", "dark", "system"])
    assert.deepEqual(APPEARANCE_LABELS, { light: "Clair", dark: "Sombre", system: "Système" })
    assert.equal(DEFAULT_APPEARANCE, "system")
  })
  it("valeur stockée inconnue, absente ou d'un autre type → défaut", () => {
    for (const value of [null, undefined, "", "DARK", "auto", 1, {}]) assert.equal(parseAppearance(value), "system")
    for (const value of APPEARANCE_PREFERENCES) assert.equal(parseAppearance(value), value)
  })
  it("« Système » suit l'appareil ; Clair et Sombre l'emportent sur l'appareil", () => {
    assert.equal(resolveTheme("system", true), "dark")
    assert.equal(resolveTheme("system", false), "light")
    assert.equal(resolveTheme("light", true), "light")
    assert.equal(resolveTheme("dark", false), "dark")
  })
  it("clé propre à chaque utilisateur ; aucune clé sans identifiant", () => {
    assert.equal(appearanceStorageKey("u1"), "planificator:appearance:u1")
    assert.notEqual(appearanceStorageKey("u1"), appearanceStorageKey("u2"))
    assert.equal(appearanceStorageKey(null), null)
    assert.equal(appearanceStorageKey(""), null)
  })
})

/** Exécute le script anti-flash dans un contexte isolé (document, localStorage, matchMedia simulés). */
function boot(userId: string | null, stored: Record<string, string>, prefersDark: boolean, storageThrows = false): string | null {
  const attributes = new Map<string, string>()
  const root = { setAttribute: (name: string, value: string) => { attributes.set(name, value) } }
  const localStorage = { getItem: (key: string) => { if (storageThrows) throw new Error("bloqué"); return stored[key] ?? null } }
  const window = { matchMedia: () => ({ matches: prefersDark }) }
  runInNewContext(appearanceBootScript(userId), { document: { documentElement: root }, localStorage, window })
  return attributes.get("data-appearance") ?? null
}

describe("apparence — script anti-flash", () => {
  it("applique la préférence de l'utilisateur, indépendamment d'un autre utilisateur du même appareil", () => {
    const stored = { "planificator:appearance:u1": "dark", "planificator:appearance:u2": "light" }
    assert.equal(boot("u1", stored, false), "dark")
    assert.equal(boot("u2", stored, true), "light")
  })
  it("sans préférence (ou sans utilisateur) : suit l'appareil", () => {
    assert.equal(boot("u3", {}, true), "dark")
    assert.equal(boot(null, {}, false), "light")
  })
  it("valeur corrompue → défaut ; stockage bloqué → aucune erreur, aucun attribut (thème clair)", () => {
    assert.equal(boot("u1", { "planificator:appearance:u1": "<script>" }, true), "dark")
    assert.equal(boot("u1", {}, true, true), null)
  })
  it("identifiant sérialisé sans possibilité de fermer la balise <script>", () => {
    const script = appearanceBootScript("</script><img src=x onerror=alert(1)>")
    assert.equal(script.includes("</script>"), false)
    assert.equal(script.includes("<"), false)
  })
})
