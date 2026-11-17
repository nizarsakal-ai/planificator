// Correctif E4 : adresse de la navigation native après le résultat d'une action du lot E (allowlist, encodage, refus).
import { test } from "node:test"
import assert from "node:assert/strict"
import { adresseApresSucces, retour, RETOUR_INITIAL } from "@/lib/actions/retour-action"

const ok = (cible?: string) => retour(true, "Opportunité OPP-0007 créée.", cible)

test("création : fiche créée, message encodé dans ok", () => {
  assert.equal(adresseApresSucces(ok("/crm/opportunites/c1_A-z"), "/crm/opportunites"), "/crm/opportunites/c1_A-z?ok=Opportunit%C3%A9+OPP-0007+cr%C3%A9%C3%A9e.")
})
test("action sans cible : page courante du lot E rouverte", () => {
  for (const p of ["/crm/opportunites", "/crm/opportunites/abc", "/automatisations"]) assert.equal(adresseApresSucces(retour(true, "Note ajoutée."), p), `${p}?ok=Note+ajout%C3%A9e.`)
})
test("erreur ou état initial : aucune navigation", () => {
  assert.equal(adresseApresSucces(retour(false, "Montant invalide."), "/crm/opportunites"), null)
  assert.equal(adresseApresSucces(RETOUR_INITIAL, "/crm/opportunites"), null)
})
test("cible hors allowlist : refusée (aucune URL arbitraire)", () => {
  for (const c of ["//evil.example/x", "https://evil.example/", "javascript:alert(1)", "/crm/opportunites", "/crm/opportunites/a/b", "/crm/opportunites/a?x=1", "/automatisations", "/dashboard", `/crm/opportunites/${"a".repeat(65)}`, "/crm/opportunites/a%2Fb", "/crm/opportunites/../admin"])
    assert.equal(adresseApresSucces(ok(c), "/crm/opportunites"), null, c)
})
test("page courante hors lot E : refusée", () => {
  for (const p of ["/opportunites", "/automatisations/x", "/crm", "//x", "/crm/opportunites/"]) assert.equal(adresseApresSucces(retour(true, "x"), p), null, p)
})
test("message hostile : encodé, jamais interprété dans le chemin", () => {
  const a = adresseApresSucces(retour(true, "a&erreur=x#h<script>"), "/automatisations")!
  assert.equal(new URL(a, "http://h").pathname, "/automatisations")
  assert.deepEqual([...new URL(a, "http://h").searchParams.keys()], ["ok"])
  assert.equal(new URL(a, "http://h").searchParams.get("ok"), "a&erreur=x#h<script>")
})
