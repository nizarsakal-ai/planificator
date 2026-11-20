/**
 * Formulaire à retour explicite (RetourFormulaire) : sur une page rouverte depuis l'historique, chaque formulaire est
 * désactivé ET l'explique sur place (le bandeau de MessageRetour peut être hors de vue en haut d'une longue page : le clic
 * semblait « ne rien faire », recette du Document Studio du 21/11/2026). Un envoi refusé est aussi signalé dans le formulaire.
 * Contrôles statiques : le verrou de page et le bandeau d'origine restent inchangés.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const c = readFileSync("src/components/crm/RetourFormulaire.tsx", "utf8")
const formulaire = c.slice(c.indexOf("export function FormulaireRetour"))

describe("FormulaireRetour : explication sur place", () => {
  it("page de l'historique : formulaire désactivé (fieldset) et message local avec lien d'actualisation", () => {
    assert.ok(formulaire.includes("const restauree = !!zone?.restauree"))
    assert.ok(formulaire.includes("<fieldset disabled={!monte || natifCree || restauree}"))
    assert.match(formulaire, /data-retour="restauree-local"[\s\S]*Formulaire désactivé : page rouverte depuis l&apos;historique\. <a href=\{chemin\}/)
  })
  it("envoi refusé : signalé dans le formulaire concerné, effacé au prochain envoi admis", () => {
    assert.ok(formulaire.includes("{ refuser?.(); setRefuseIci(true); return }"))
    assert.ok(formulaire.includes("setRefuseIci(false)"))
    assert.ok(formulaire.includes(`data-retour="refus-local"`))
  })
  it("verrou de page et bandeau de MessageRetour inchangés", () => {
    assert.ok(c.includes("prendre: () => (fige.current || occupe.current ? false : (occupe.current = true)),"))
    assert.ok(c.includes(`data-retour="restauree" hidden={!zone?.restauree}`))
    assert.ok(c.includes("if (zoneDeLHistorique(rendu)) { verrou.figer(); setRestauree(true) }"))
  })
})
