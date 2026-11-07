// Captures du harnais COMPLÉMENTAIRE devis-v2 (PRÉPARÉES, NON EXÉCUTÉES), dans le confinement sans réseau. Pilote DÉJÀ
// INSTALLÉ et attesté par T1, contrôlé exactement comme dans captures-puppeteer.mjs du harnais v6 (bloc recopié à
// l'identique). Matrice : 2 dialogues (« Envoyer le devis », « Créer la facture ») × clair/sombre × bureau/mobile = 8.
// Assertions, sans RIEN soumettre (aucun envoi, aucune acceptation, aucune facture créée par les captures) :
//  - page du devis : statut < 400, URL finale identique, titre = numéro du devis, data-appearance, fonds V1 du conteneur
//    et de l'en-tête identiques au harnais v6 (design V1 conservé) ;
//  - dialogue d'envoi : ouvert, contact de la demande pré-rempli (nom et e-mail fictifs attendus), bouton « Envoyer à … » ;
//  - dialogue de facturation : ouvert, champ du bon de commande présent ; saisie « BC-2026-0001 » acceptée sans erreur ;
//    saisie « BC-Ж » refusée par le message attendu (R2), puis effacée.
// Résultats : resultats.json et une capture par combinaison ; code de retour non nul au moindre écart.
// v13 (07/11/2026, après la reprise n° 3) : le tiroir MobileNav (src/components/layout/MobileNav.tsx:114) est TOUJOURS monté avec
// role="dialog" (fermé : aria-hidden, inert ; md:hidden au bureau) et précède dans le DOM le dialogue Radix (portail en fin de body).
// L'attente et la lecture portaient sur le PREMIER [role="dialog"] : au bureau, attente du menu caché ; sur mobile, lecture du texte du
// menu hors écran. Désormais : dialogue Radix OUVERT (data-state="open", non aria-hidden, visible) portant le titre attendu et son
// champ (#rec-email / #po-ref) ; assertions lues DANS ce dialogue ; capture après fin des animations (opacité 1, aucune animation en
// cours). Saisie : sélection par el.select() (le triple clic ne sélectionne pas en émulation tactile : « BC-BC-2026-0001 » observé),
// valeur vérifiée, messages attendus par attente bornée du rendu React. Diagnostics consignés : dialogues présents, géométrie,
// débordement horizontal (constat séparé, non masqué).
// v14 : débordement BLOQUANT (correctif produit QuoteSendDialog.tsx) ; état d'attente d'animation lu par Animation.pending.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"

// Entrée du pilote RÉSOLUE depuis le package.json du paquet installé (exports["."] puis main), puis contrôlée contre le
// manifeste du pilote attesté par T1 (MANIFESTE-PILOTE-NAVIGATEUR.sha256, 07385fa0…) : package.json et fichier d'entrée
// doivent avoir les empreintes attestées. Le paquet 25.16.0 attesté est purement ESM (aucun lib/cjs) : une résolution
// createRequire (conditions « require ») n'est pas probante ; toute autre entrée que celle attestée est refusée.
const ROOT = "/opt/runtime/pilote-navigateur/node_modules/puppeteer-core"
const T1 = { "package.json": "338a14fd6d50b1db4877a6ed1b08791dbfb9521a2c2abb750bc2f67537a6723b", "lib/puppeteer/puppeteer-core.js": "059b251260c5499581d308029e4a207102624d35f1390b6b0fdad6563f5d186d" }
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex")
if (sha(`${ROOT}/package.json`) !== T1["package.json"]) { console.error("REFUS : package.json du pilote différent de T1"); process.exit(3) }
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"))
if (pkg.version !== "25.16.0") { console.error(`REFUS : pilote ${pkg.version}, 25.16.0 attendu`); process.exit(3) }
const pick = (e) => (typeof e === "string" ? e : e && (pick(e.import) ?? pick(e.node) ?? pick(e.default)))
const entry = (pick(pkg.exports?.["."] ?? pkg.exports) ?? pkg.main ?? "").replace(/^\.\//, "")
if (!(entry in T1) || entry === "package.json") { console.error(`REFUS : entrée résolue « ${entry} » non attestée par T1`); process.exit(3) }
const ENTRY = resolvePath(ROOT, entry)
if (sha(ENTRY) !== T1[entry]) { console.error("REFUS : fichier d'entrée du pilote différent de T1"); process.exit(3) }
const mod = await import(pathToFileURL(ENTRY).href)
const puppeteer = mod.default ?? mod, KnownDevices = mod.KnownDevices ?? puppeteer.KnownDevices
if (typeof puppeteer.launch !== "function" || !KnownDevices?.["iPhone 13"]) { console.error("REFUS : API du pilote inattendue"); process.exit(3) }
console.log(`pilote : ${ENTRY} (${pkg.version}, empreintes T1 conformes)`)
const BASE = process.env.PREVIEW_URL ?? "", OUT = process.env.PREUVES ?? "", IDS = process.env.DEVIS_IDS_FILE ?? ""
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE) || !OUT || !IDS) { console.error("REFUS : URL hors boucle locale, dossier de preuves ou identifiants absents"); process.exit(2) }
mkdirSync(OUT, { recursive: true })
const ids = JSON.parse(readFileSync(IDS, "utf8"))
const EXPECTED = { light: { backdrop: "rgb(246, 241, 231)", header: "rgb(251, 247, 239)" }, dark: { backdrop: "rgb(188, 186, 180)", header: "rgb(205, 203, 197)" } }
const LAYOUTS = { bureau: null, mobile: KnownDevices["iPhone 13"] }
const DIALOGS = [
  { name: "envoi", quoteId: ids.draftQuoteId, number: ids.draftQuoteNumber, button: "Envoyer au client", title: "Envoyer le devis", field: "#rec-email" },
  { name: "facturation", quoteId: ids.acceptedQuoteId, number: ids.acceptedQuoteNumber, button: "Créer la facture", title: "Créer la facture depuis ce devis", field: "#po-ref" },
]
const clickButton = (page, label) => page.evaluate((l) => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === l); if (!b) return false; b.click(); return true }, label)
// Dialogue Radix ouvert, visible, portant le titre et le champ attendus (jamais le tiroir MobileNav).
const OPEN_DIALOG = (title, field) => {
  for (const el of document.querySelectorAll('[role="dialog"][data-state="open"]')) {
    if (el.getAttribute("aria-hidden") === "true" || el.closest("[inert]")) continue
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
    if (r.width <= 0 || r.height <= 0 || cs.display === "none" || cs.visibility === "hidden") continue
    const h = el.querySelector("h2, [id$='-title']")
    if ((h?.textContent ?? "").trim() === title && el.querySelector(field)) return el
  }
  return null
}
async function openDialog(page, d) {
  const handle = await page.waitForFunction(OPEN_DIALOG, { timeout: 10000 }, d.title, d.field)
  const el = handle.asElement()
  // Rendu stabilisé : opacité 1 et aucune animation CSS en cours dans le dialogue (animate-in Radix 200 ms).
  await page.waitForFunction((e) => getComputedStyle(e).opacity === "1" && e.getAnimations({ subtree: true }).every((a) => a.playState !== "running" && !a.pending), { timeout: 5000 }, el)
  return el
}
const textOf = (el) => el.evaluate((e) => e.textContent ?? "")
async function setInput(dlg, selector, value) {
  const input = await dlg.$(selector)
  await input.evaluate((e) => { e.focus(); e.select() })
  await input.press("Backspace")
  if (value) await input.type(value)
  return input.evaluate((e) => e.value)
}
// Attente bornée d'un état du texte du dialogue (rendu React après saisie).
const waitText = (page, el, needle, present) => page.waitForFunction((e, n, p) => (e.textContent ?? "").includes(n) === p, { timeout: 5000 }, el, needle, present).then(() => true, () => false)
async function diagnostics(page, dlg) {
  return page.evaluate((e) => {
    const vw = document.documentElement.clientWidth
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((x) => { const r = x.getBoundingClientRect(); return { label: x.getAttribute("aria-label") ?? (x.querySelector("h2")?.textContent ?? "").trim(), state: x.getAttribute("data-state"), ariaHidden: x.getAttribute("aria-hidden"), inert: x.hasAttribute("inert"), display: getComputedStyle(x).display, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] } })
    const out = { viewport: vw, documentScrollWidth: document.documentElement.scrollWidth, dialogs }
    if (e) {
      const r = e.getBoundingClientRect()
      out.dialog = { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }
      out.debordements = [...e.querySelectorAll("*")].map((c) => ({ c, r: c.getBoundingClientRect() })).filter(({ r: cr }) => cr.width > 0 && (cr.right > Math.min(r.right, vw) + 1 || cr.left < Math.max(r.left, 0) - 1))
        .slice(0, 8).map(({ c, r: cr }) => ({ el: c.tagName.toLowerCase() + (c.id ? "#" + c.id : ""), texte: (c.textContent ?? "").trim().slice(0, 60), left: Math.round(cr.left), right: Math.round(cr.right) }))
      out.debordement = r.left < -1 || r.right > vw + 1 || e.scrollWidth > e.clientWidth + 1 || out.debordements.length > 0
    }
    return out
  }, dlg ?? null)
}
const results = []
const browser = await puppeteer.launch({
  executablePath: "/usr/lib/chromium/chromium-headless-shell", headless: "shell", pipe: true, args: ["--no-sandbox"],
  userDataDir: `${process.env.TMPDIR}/profil-captures-devis`, timeout: 30000, protocolTimeout: 60000,
})
try {
  for (const [layout, device] of Object.entries(LAYOUTS)) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.createBrowserContext()
      const page = await context.newPage()
      if (device) await page.emulate(device); else await page.setViewport({ width: 1440, height: 900 })
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme === "dark" ? "light" : "dark" }])
      await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" })
      await page.type("#email", "admin@entreprise-test.local")
      await page.type("#password", "Admin123!")
      await Promise.all([page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 20000 }), page.click('button[type="submit"]')])
      const userId = await page.evaluate(async () => (await (await fetch("/api/auth/session")).json())?.user?.id ?? null)
      if (typeof userId !== "string" || !userId) throw new Error("identifiant de session introuvable : thème non fixable")
      await page.evaluateOnNewDocument((k, v) => { try { localStorage.setItem(k, v) } catch { /* vérifié par l'assertion */ } }, `planificator:appearance:${userId}`, theme)
      for (const d of DIALOGS) {
        const path = `/devis/${d.quoteId}`
        const file = `${OUT}/${d.name}-${theme}-${layout}.png`
        const r = { dialogue: d.name, path, theme, layout, status: null, finalUrl: null, appearance: null, backdrop: null, header: null, ok: false, problems: [], capture: file, diagnostic: null, debordement: null }
        let dlg = null
        try {
          const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" })
          r.status = res?.status() ?? null; r.finalUrl = page.url()
          if (!res || res.status() >= 400) r.problems.push(`statut ${r.status}`)
          if (new URL(r.finalUrl).pathname !== path) r.problems.push(`URL finale ${new URL(r.finalUrl).pathname} (redirection)`)
          const h1 = await page.$$eval("h1", (els) => els.map((e) => e.textContent ?? ""))
          if (!h1.some((t) => t.includes(d.number))) r.problems.push(`titre « ${d.number} » absent`)
          r.appearance = await page.evaluate(() => document.documentElement.getAttribute("data-appearance"))
          if (r.appearance !== theme) r.problems.push(`data-appearance=${r.appearance} au lieu de ${theme}`)
          r.backdrop = await page.$eval("[data-app-backdrop]", (el) => getComputedStyle(el).backgroundColor).catch(() => "absent")
          r.header = await page.$eval("[data-app-header]", (el) => getComputedStyle(el).backgroundColor).catch(() => "absent")
          if (r.backdrop !== EXPECTED[theme].backdrop) r.problems.push(`fond ${r.backdrop} au lieu de ${EXPECTED[theme].backdrop}`)
          if (r.header !== EXPECTED[theme].header) r.problems.push(`en-tête ${r.header} au lieu de ${EXPECTED[theme].header}`)
          if (!(await clickButton(page, d.button))) r.problems.push(`bouton « ${d.button} » absent`)
          else {
            dlg = await openDialog(page, d)
            if (d.name === "envoi") {
              const name = await dlg.$eval("#rec-name", (el) => el.value).catch(() => null)
              const email = await dlg.$eval("#rec-email", (el) => el.value).catch(() => null)
              if (name !== ids.expectedContact.name) r.problems.push(`nom pré-rempli « ${name} »`)
              if (email !== ids.expectedContact.email) r.problems.push(`e-mail pré-rempli « ${email} »`)
              if (!(await textOf(dlg)).includes(`Envoyer à ${ids.expectedContact.email}`)) r.problems.push("bouton de confirmation « Envoyer à … » absent")
              if ((await textOf(dlg)).includes("noreply@plateforme-fictive.example")) r.problems.push("expéditeur technique proposé")
            } else {
              const v1 = await setInput(dlg, "#po-ref", "BC-Ж")
              if (v1 !== "BC-Ж") r.problems.push(`saisie « BC-Ж » non obtenue (valeur « ${v1} »)`)
              else if (!(await waitText(page, dlg, "non pris en charge par le PDF", true))) r.problems.push("caractère hors encodage non refusé (R2)")
              const v2 = await setInput(dlg, "#po-ref", "BC-2026-0001")
              if (v2 !== "BC-2026-0001") r.problems.push(`saisie « BC-2026-0001 » non obtenue (valeur « ${v2} »)`)
              else if (!(await waitText(page, dlg, "non pris en charge", false))) r.problems.push("référence valide refusée")
            }
            // Capture APRÈS rendu stabilisé (les saisies peuvent relancer une transition) ; géométrie et débordement consignés.
            await page.waitForFunction((e) => getComputedStyle(e).opacity === "1" && e.getAnimations({ subtree: true }).every((a) => a.playState !== "running" && !a.pending), { timeout: 5000 }, dlg)
            r.diagnostic = await diagnostics(page, dlg)
            r.debordement = r.diagnostic.debordement === true
            // v14 : le débordement du dialogue d'envoi est corrigé dans le produit (QuoteSendDialog.tsx) : tout débordement est un ÉCHEC.
            if (r.debordement) r.problems.push(`débordement horizontal du dialogue : ${JSON.stringify(r.diagnostic.debordements ?? []).slice(0, 400)}`)
            await page.screenshot({ path: file, fullPage: false })
            await page.keyboard.press("Escape")
            await page.waitForFunction(() => !document.querySelector('[role="dialog"][data-state="open"]'), { timeout: 5000 }).catch(() => r.problems.push("dialogue non refermé par Échap"))
          }
        } catch (e) { r.problems.push(`erreur : ${e instanceof Error ? e.message : String(e)}`) }
        if (!r.ok && r.problems.length && !r.diagnostic) r.diagnostic = await diagnostics(page, dlg).catch((e) => ({ indisponible: String(e) }))
        r.ok = r.problems.length === 0
        results.push(r)
        console.log(`${r.ok ? "ok    " : "ÉCHEC "} ${theme}/${layout} ${d.name}${r.ok ? "" : ` : ${r.problems.join(" ; ")}`}${r.debordement ? " | CONSTAT : débordement horizontal du dialogue" : ""}`)
        if (!r.ok || r.debordement) console.log(`  diagnostic ${JSON.stringify(r.diagnostic)}`)
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
  writeFileSync(`${OUT}/resultats.json`, JSON.stringify({ base: BASE, total: results.length, echecs: results.filter((r) => !r.ok).length, debordements: results.filter((r) => r.debordement).length, resultats: results }, null, 2))
}
process.exit(results.length === DIALOGS.length * 4 && results.every((r) => r.ok) ? 0 : 1)
