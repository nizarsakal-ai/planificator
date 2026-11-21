/**
 * Lot F v3 (recette Chrome F v2) : retour explicite du centre de connecteurs par le mécanisme qualifié E4.
 * - Liste blanche EXACTE : « /connecteurs » est admis seulement pour l'actualisation sans cible ; jamais comme cible ;
 *   aucune variante ; liste des fiches CRM et pages du lot E inchangées.
 * - Raccordement statique : actions à retour par état (sans revalidatePath ni redirect de succès), écran enveloppé par
 *   ZoneRetour, message par MessageRetour, les trois formulaires par FormulaireRetour.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { adresseApresSucces, retour, RETOUR_INITIAL } from "@/lib/actions/retour-action"

const read = (f: string) => readFileSync(f, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

describe("liste blanche exacte de /connecteurs", () => {
  it("action sans cible : /connecteurs rouvert avec le message encodé dans « ok »", () => {
    assert.equal(adresseApresSucces(retour(true, "Synchronisation simulée : 24 reçu(s)."), "/connecteurs"), "/connecteurs?ok=Synchronisation+simul%C3%A9e+%3A+24+re%C3%A7u%28s%29.")
  })
  it("variantes de chemin refusées (exactitude)", () => {
    for (const p of ["/connecteurs/", "/connecteurs/shopify", "/Connecteurs", "/connecteurs-x", "/connecteur", "//connecteurs", "/connecteurs%2F", "/x/connecteurs"])
      assert.equal(adresseApresSucces(retour(true, "x"), p), null, p)
  })
  it("/connecteurs jamais admis comme cible ; fiches CRM et pages E inchangées", () => {
    assert.equal(adresseApresSucces(retour(true, "x", "/connecteurs"), "/connecteurs"), null, "cible")
    assert.equal(adresseApresSucces(retour(true, "x", "/connecteurs"), "/crm/opportunites"), null, "cible depuis une page E")
    assert.equal(adresseApresSucces(retour(true, "x", "/crm/opportunites/c1"), "/connecteurs"), "/crm/opportunites/c1?ok=x", "fiche CRM : comportement E")
    for (const p of ["/crm/opportunites", "/crm/opportunites/abc", "/automatisations"]) assert.equal(adresseApresSucces(retour(true, "x"), p), `${p}?ok=x`, p)
    // Intégration FGHI v2 : « /assistant » est désormais rouvert sans cible (tests/assistant/retour-assistant.test.ts).
    for (const p of ["/stock", "/dashboard"]) assert.equal(adresseApresSucces(retour(true, "x"), p), null, `${p} : non ajouté`)
  })
  it("erreur ou état initial : aucune navigation (erreur affichée sur place)", () => {
    assert.equal(adresseApresSucces(retour(false, "Activez d'abord la simulation : le connecteur est désactivé."), "/connecteurs"), null)
    assert.equal(adresseApresSucces(RETOUR_INITIAL, "/connecteurs"), null)
  })
  it("message hostile : encodé, chemin intact", () => {
    const a = adresseApresSucces(retour(true, "a&erreur=x#h<script>"), "/connecteurs")!
    const u = new URL(a, "http://h")
    assert.equal(u.pathname, "/connecteurs")
    assert.deepEqual([...u.searchParams.keys()], ["ok"])
  })
  it("source : la liste des fiches (FICHE) n'est pas modifiée ; /connecteurs dans une liste distincte", () => {
    const src = read("src/lib/actions/retour-action.ts")
    assert.ok(src.includes("const FICHE = /^\\/crm\\/opportunites\\/[A-Za-z0-9_-]{1,64}$/"))
    assert.ok(src.includes("const PAGES_LOT_E = /^\\/(?:crm\\/opportunites(?:\\/[A-Za-z0-9_-]{1,64})?|automatisations)$/"))
    assert.ok(src.includes("const PAGES_LOT_F = /^\\/connecteurs$/"))
  })
})

describe("raccordement des Connecteurs aux retours explicites", () => {
  it("actions : retour par état (RetourAction), signature compatible useActionState, sans revalidatePath ni redirect de succès", () => {
    const a = read("src/lib/actions/connector.actions.ts")
    const c = code(a)
    assert.match(a, /^"use server"/)
    assert.doesNotMatch(c, /revalidatePath|redirect\(`\$\{PATH\}|back\(/, "aucune transition serveur après mutation")
    assert.equal((c.match(/redirect\(/g) ?? []).length, 1, "seule redirection : vers /login si non connecté")
    assert.ok(c.includes(`if (e instanceof ConnectorAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")`))
    for (const n of ["setConnectorModeAction", "syncConnectorAction", "resetConnectorWatermarkAction"]) {
      assert.match(c, new RegExp(`export async function ${n}\\(a: RetourAction \\| FormData, b\\?: FormData\\) \\{\\n  const form = formulaireDe\\(a, b\\)\\n  return run\\(`), n)
    }
    assert.ok(c.includes("await requireConnectorAdmin()"), "garde serveur conservée")
    assert.ok(c.includes(`if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de réinitialisation." }`), "confirmation serveur conservée")
  })
  it("écran : ZoneRetour, MessageRetour et FormulaireRetour seulement ; aucun <form> brut ; refus d'accès avant la zone", () => {
    const p = read("src/app/(dashboard)/connecteurs/page.tsx")
    const c = code(p)
    assert.ok(c.includes(`import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"`))
    assert.ok(c.includes("<ZoneRetour rendu={Date.now()}>") && c.includes("</ZoneRetour>"))
    assert.ok(c.includes("<MessageRetour><StockFlash params={params} /></MessageRetour>"))
    assert.doesNotMatch(c, /<form[\s>]/, "aucun formulaire hors retour explicite")
    for (const n of ["setConnectorModeAction", "syncConnectorAction", "resetConnectorWatermarkAction"]) assert.ok(c.includes(`<FormulaireRetour action={${n}}`), n)
    // LOT-8B : + bascule « connexion réelle », enregistrement et révocation des identifiants (6 au total).
    for (const n of ["configureLiveConnectorAction", "revokeLiveConnectorAction"]) assert.ok(c.includes(`<FormulaireRetour action={${n}}`), n)
    assert.equal((c.match(/<FormulaireRetour /g) ?? []).length, 6)
    assert.ok(c.indexOf("if (!ctx) return <AdminOnlyNotice />") < c.indexOf("<ZoneRetour"), "garde de page avant toute lecture et avant la zone")
  })
  it("v5 : « Aperçu des données reçues » est un lien HTML natif (navigation du document), href et filtrage inchangés", () => {
    const c = code(read("src/app/(dashboard)/connecteurs/page.tsx"))
    assert.ok(c.includes('<a href={`/connecteurs?apercu=${c.def.key}`} className="text-xs text-[#0f3460] underline">Aperçu des données reçues</a>'))
    assert.doesNotMatch(c, /from "next\/link"|<Link[\s>]/, "aucune transition client next/link sur l'écran")
    assert.ok(c.includes(`const preview = typeof params.apercu === "string" && isConnectorKey(params.apercu) ? params.apercu : null`), "filtrage isConnectorKey conservé")
  })
})
