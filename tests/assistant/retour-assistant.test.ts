/**
 * Intégration FGHI v2 (incident Chrome, cinq drapeaux actifs : après « Analyser maintenant », URL « /assistant?ok=… »
 * mais contenu non rendu) : retour explicite de l'assistant par le mécanisme qualifié E4, sur le modèle exact des
 * Connecteurs (lot F v3).
 * - « /assistant » admis seulement pour l'actualisation SANS cible ; jamais comme cible explicite ; aucune variante.
 * - Encodage du message et retours E, F (connecteurs), G, H, I inchangés.
 * - Raccordement statique : trois actions à retour par état (sans revalidatePath ni redirect de succès), écran enveloppé
 *   par ZoneRetour, message par MessageRetour, trois FormulaireRetour ; refus d'accès avant la zone ; approbation explicite,
 *   sources activées et liens des sources inchangés.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { adresseApresSucces, retour, RETOUR_INITIAL } from "@/lib/actions/retour-action"

const read = (f: string) => readFileSync(f, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const ACTIONS = "src/lib/actions/assistant.actions.ts"
const PAGE = "src/app/(dashboard)/assistant/page.tsx"

describe("retour natif de l'assistant", () => {
  it("succès sans cible depuis /assistant : page rouverte, message encodé dans « ok »", () => {
    assert.equal(
      adresseApresSucces(retour(true, "Analyse terminée : 1 nouvelle(s) proposition(s), 0 déjà connue(s). Rien n'est fait sans votre approbation."), "/assistant"),
      "/assistant?ok=Analyse+termin%C3%A9e+%3A+1+nouvelle%28s%29+proposition%28s%29%2C+0+d%C3%A9j%C3%A0+connue%28s%29.+Rien+n%27est+fait+sans+votre+approbation.",
    )
    for (const m of ["Proposition approuvée : tâche créée.", "Proposition refusée : elle ne sera plus proposée."]) {
      const u = new URL(adresseApresSucces(retour(true, m), "/assistant")!, "http://h")
      assert.deepEqual([u.pathname, u.searchParams.get("ok")], ["/assistant", m])
    }
  })
  it("/assistant jamais admis comme cible explicite, depuis aucune page", () => {
    for (const p of ["/assistant", "/connecteurs", "/crm/opportunites", "/pre-paie", "/boutique", "/studio-documents"]) {
      assert.equal(adresseApresSucces(retour(true, "x", "/assistant"), p), null, p)
    }
  })
  it("variantes de chemin refusées (exactitude)", () => {
    for (const p of ["/assistant/", "/assistant/x", "/Assistant", "/assistants", "/assistant-x", "//assistant", "/assistant%2F", "/x/assistant"]) {
      assert.equal(adresseApresSucces(retour(true, "x"), p), null, p)
    }
  })
  it("erreur ou état initial : aucune navigation ; message hostile encodé, chemin intact", () => {
    assert.equal(adresseApresSucces(retour(false, "Cochez la confirmation d'approbation."), "/assistant"), null)
    assert.equal(adresseApresSucces(RETOUR_INITIAL, "/assistant"), null)
    const u = new URL(adresseApresSucces(retour(true, "a&erreur=x#h<script>"), "/assistant")!, "http://h")
    assert.equal(u.pathname, "/assistant")
    assert.deepEqual([...u.searchParams.keys()], ["ok"])
  })
  it("retours E, F (connecteurs), G, H, I inchangés", () => {
    assert.equal(adresseApresSucces(retour(true, "x", "/crm/opportunites/c1"), "/crm/opportunites"), "/crm/opportunites/c1?ok=x")
    for (const p of ["/crm/opportunites", "/automatisations", "/connecteurs", "/studio-documents", "/pre-paie/p1", "/marketing", "/boutique"]) assert.equal(adresseApresSucces(retour(true, "x"), p), `${p}?ok=x`, p)
    for (const c of ["/studio-documents/documents/d1", "/pre-paie/p1", "/boutique/commandes/o1"]) assert.equal(adresseApresSucces(retour(true, "x", c), "/assistant"), `${c}?ok=x`, c)
    for (const c of ["/connecteurs", "/automatisations", "/marketing", "/pre-paie/p1/export", "/studio-documents/documents/d1/pdf"]) assert.equal(adresseApresSucces(retour(true, "x", c), "/assistant"), null, c)
    const src = read("src/lib/actions/retour-action.ts")
    assert.ok(src.includes("const FICHE = /^\\/crm\\/opportunites\\/[A-Za-z0-9_-]{1,64}$/"))
    assert.ok(src.includes("const PAGES_LOT_F = /^\\/connecteurs$/"))
    assert.ok(src.includes("const PAGES_LOT_F_ASSISTANT = /^\\/assistant$/"))
    const cibles = src.slice(src.indexOf("const admis = r.cible"), src.indexOf(":", src.indexOf("const admis = r.cible") + 30))
    assert.doesNotMatch(cibles, /PAGES_LOT_F_ASSISTANT|PAGES_LOT_F\b/, "aucune liste F parmi les cibles explicites")
  })
})

describe("raccordement de l'assistant aux retours explicites", () => {
  it("actions : retour par état, signature compatible useActionState, sans revalidatePath ni redirect de succès", () => {
    const a = read(ACTIONS), c = code(a)
    assert.match(a, /^"use server"/)
    assert.doesNotMatch(c, /revalidatePath|from "next\/cache"|back\(|redirect\(`/, "aucune transition serveur après mutation")
    assert.equal((c.match(/redirect\(/g) ?? []).length, 1, "seule redirection : /login si non connecté")
    assert.ok(c.includes(`if (e instanceof AssistantAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")`))
    assert.ok(c.includes("async function run(fn: (ctx: AssistantAccessContext) => Promise<Outcome>): Promise<RetourAction> {"))
    assert.ok(c.includes("return result.ok ? retour(true, result.okMessage) : retour(false, result.error)"), "aucune cible explicite")
    assert.ok(c.includes("export async function analyseAction(a?: RetourAction | FormData, b?: FormData) {"))
    for (const n of ["approveProposalAction", "rejectProposalAction"]) {
      assert.match(c, new RegExp(`export async function ${n}\\(a: RetourAction \\| FormData, b\\?: FormData\\) \\{\\n  const form = formulaireDe\\(a, b\\)\\n  return run\\(`), n)
    }
    assert.ok(c.includes("result = await fn(await requireAssistantAdmin())"), "garde serveur conservée")
    assert.ok(c.includes(`if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation d'approbation." }`), "approbation explicite")
    assert.ok(c.includes("svc.generateProposals(prisma, ctx, enabledSources())") && /svc\.approveProposal\(prisma, ctx, [^\n]*, undefined, enabledSources\(\)\)/.test(c), "sources activées")
  })
  it("écran : ZoneRetour, MessageRetour et trois FormulaireRetour ; aucun <form> brut ; refus avant la zone ; liens des sources natifs", () => {
    const c = code(read(PAGE))
    assert.ok(c.includes(`import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"`))
    assert.ok(c.includes("<ZoneRetour rendu={Date.now()}>") && c.includes("</ZoneRetour>"))
    assert.ok(c.includes("<MessageRetour><StockFlash params={params} /></MessageRetour>"))
    assert.doesNotMatch(c, /<form[\s>]/, "aucun formulaire hors retour explicite")
    for (const n of ["analyseAction", "approveProposalAction", "rejectProposalAction"]) assert.ok(c.includes(`<FormulaireRetour action={${n}}`), n)
    assert.equal((c.match(/<FormulaireRetour /g) ?? []).length, 3)
    assert.ok(c.indexOf("if (!ctx) return <AdminOnlyNotice />") < c.indexOf("loadAssistantPage(prisma"), "garde avant toute lecture")
    assert.ok(c.indexOf("if (!ctx) return <AdminOnlyNotice />") < c.indexOf("<ZoneRetour"), "refus avant la zone")
    assert.ok(c.includes(`<a href={s.href} className="text-[#0f3460] underline">{s.label}</a>`), "liens des sources inchangés")
    assert.ok(c.includes(`<input type="checkbox" name="confirm" value="oui" required />`), "case d'approbation conservée")
    assert.doesNotMatch(c, /from "next\/link"|<Link[\s>]/)
  })
})
