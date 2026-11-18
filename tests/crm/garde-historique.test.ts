// Correctif E4 (recette Mac E4-08) : garde synchrone des documents ouverts par l'historique (avant hydratation), limitée à la
// zone rendue à l'instant serveur du document d'origine (une revisite par le routeur client porte un autre instant). Le script ne
// touche jamais au DOM (« querySelectorAll » simulé : aucun élément modifié).
import { test } from "node:test"
import assert from "node:assert/strict"
import { gardeHistorique } from "@/lib/actions/retour-action"

const R = 1763380000123
type Ecouteur = { f: (e?: unknown) => void; capture: unknown }
function monde(type: string | undefined, nom: string, ici: string) {
  const ecouteurs: Record<string, Ecouteur[]> = {}, bandeau = { hidden: true }, fenetre: Record<string, unknown> = {}
  const env = {
    window: fenetre, performance: { getEntriesByType: () => (type ? [{ type, name: nom }] : []) }, location: new URL(ici), URL, Number,
    document: { readyState: "loading", querySelectorAll: (s: string) => (s.includes(`data-rendu="${R}"`) ? [bandeau] : []), addEventListener: (n: string, f: (e?: unknown) => void, capture: unknown) => { (ecouteurs[n] ??= []).push({ f, capture }) } },
  }
  new Function(...Object.keys(env), gardeHistorique(R))(...Object.values(env))
  const soumettre = (rendu: number | null) => {
    const e = { bloque: false, target: { closest: (s: string) => (rendu !== null && s === "[data-zone-retour]" ? { getAttribute: (a: string) => (a === "data-rendu" ? String(rendu) : null) } : null) }, preventDefault() { this.bloque = true }, stopImmediatePropagation() {} }
    for (const x of ecouteurs.submit ?? []) x.f(e)
    return e.bloque
  }
  for (const x of ecouteurs.DOMContentLoaded ?? []) x.f()
  return { fenetre, bandeau, soumettre, ecouteurs }
}
const F = "http://h/crm/opportunites/abc"

test("document ouvert par l'historique : zone d'origine bloquée en capture, instant noté, AUCUNE mutation du DOM", () => {
  const w = monde("back_forward", F, F)
  assert.equal(w.bandeau.hidden, true)
  assert.equal(w.ecouteurs.submit?.[0].capture, true)
  assert.equal(w.fenetre.__e4RenduHistorique, R)
  assert.equal(w.soumettre(R), true)
  assert.equal(w.soumettre(null), false)
})
test("revisite par le routeur client (zone d'un autre instant, même URL) : non bloquée", () => {
  const w = monde("back_forward", F, F)
  assert.equal(w.soumettre(R + 1), false)
})
test("navigation normale, rechargement, entrée absente, autre URL ou query : aucune garde", () => {
  for (const [t, nom] of [["navigate", F], ["reload", F], [undefined, F], ["back_forward", F + "?ok=x"]] as const) {
    const w = monde(t, nom, F)
    assert.equal(w.ecouteurs.submit, undefined); assert.equal(w.fenetre.__e4RenduHistorique, undefined)
  }
})
test("instant non numérique : neutralisé (-1), jamais interpolé tel quel", () => {
  assert.match(gardeHistorique(Number.NaN), /var R="-1"/)
  assert.match(gardeHistorique(12.7), /var R="12"/)
})
