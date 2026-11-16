/**
 * Banc navigateur de l'autocomplétion d'adresses (vrais formulaires Clients / Chantiers, server actions
 * remplacées par des enregistreurs, API IGN simulée par interception réseau).
 *   npm run test:address:browser   (construit le banc dans un dossier temporaire)
 *   node tests/address/browser/run.cjs [dossier]   (dossier : harness.js + harness.css déjà construits)
 */
const { chromium, devices } = require("playwright")
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")

const { execFileSync } = require("node:child_process")
const os = require("node:os")

function buildHarness() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "address-harness-"))
  const root = path.resolve(__dirname, "../../..")
  execFileSync(process.execPath, [path.join(__dirname, "build.mjs"), path.join(out, "harness.js")], { cwd: root, stdio: "inherit" })
  execFileSync(path.join(root, "node_modules/.bin/tailwindcss"), ["-i", "src/app/globals.css", "-o", path.join(out, "harness.css"), "--content", "./src/**/*.{ts,tsx}"], { cwd: root, stdio: "ignore" })
  return out
}

const dir = process.argv[2] || buildHarness()
const ORIGIN = "http://harness.local"
const results = []

const IGN = (text) => ({
  status: "OK",
  results: [
    { fulltext: `12 Rue de Rivoli, 75001 Paris`, street: "Rue de Rivoli", zipcode: "75001", city: "Paris", x: 2.35, y: 48.85 },
    { fulltext: `12 Rue de Rivoli, 93100 Montreuil`, street: "Rue de Rivoli", zipcode: "93100", city: "Montreuil", x: 2.44, y: 48.86 },
    { fulltext: `Rue ${text}, 11170 Alzonne`, street: `Rue ${text}`, zipcode: "11170", city: "Alzonne", x: 2.17, y: 43.26 },
  ],
})

async function setup(browser, deviceOpts) {
  const context = await browser.newContext({ ...deviceOpts, locale: "fr-FR" })
  const page = await context.newPage()
  const ign = { mode: "ok", requests: [], delayFor: null }
  await page.route(`${ORIGIN}/**`, (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script src="/harness.js"></script></body></html>` })
    return route.fulfill({ path: path.join(dir, p.slice(1)) })
  })
  await page.route("https://data.geopf.fr/**", async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    ign.requests.push({ url, headers: await req.allHeaders(), at: Date.now() })
    const text = url.searchParams.get("text")
    if (ign.delayFor && text === ign.delayFor.text) await new Promise((r) => setTimeout(r, ign.delayFor.ms))
    const cors = { "access-control-allow-origin": "*" }
    if (ign.mode === "network") return route.abort("internetdisconnected").catch(() => {})
    if (ign.mode === "429") return route.fulfill({ status: 429, headers: cors, body: "{}" }).catch(() => {})
    if (ign.mode === "500") return route.fulfill({ status: 500, headers: cors, body: "{}" }).catch(() => {})
    if (ign.mode === "slow") { await new Promise((r) => setTimeout(r, 5000)); }
    if (ign.mode === "empty") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ results: [] }) }).catch(() => {})
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(IGN(text)) }).catch(() => {})
  })
  const errors = []
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${ORIGIN}/`)
  return { context, page, ign, errors }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const calls = (page) => page.evaluate(() => window.__calls)

async function pick(page, scope, touch, index = 0) {
  const option = scope.locator('ul[role="listbox"] [role="option"]').nth(index)
  await option.waitFor({ state: "visible" })
  if (touch) await option.tap(); else await option.click()
}

async function scenario(name, device, fn) {
  try { await fn(); results.push({ device, name, ok: true }) }
  catch (e) { results.push({ device, name, ok: false, error: String(e && e.message || e).split("\n").slice(0, 4).join(" | ") }) }
}

async function runDevice(browser, label, deviceOpts, touch) {
  let env = await setup(browser, deviceOpts)
  const fresh = async () => { await env.context.close(); env = await setup(browser, deviceOpts) }
  const sec = (id) => env.page.getByTestId(id)
  const addressIn = (id) => sec(id).locator('input[role="combobox"]')

  await scenario("Seuil : < 3 caractères (hors espaces) → aucun appel, liste fermée", label, async () => {
    const input = addressIn("client-create")
    await input.click()
    await input.pressSequentially("  12 ")
    await wait(700)
    assert.equal(env.ign.requests.length, 0)
    assert.equal(await input.getAttribute("aria-expanded"), "false")
    await input.pressSequentially("r")
    await sec("client-create").locator('ul[role="listbox"] [role="option"]').first().waitFor()
    assert.equal(env.ign.requests.length, 1)
    assert.equal(env.ign.requests[0].url.searchParams.get("text"), "12 r")
    // Repasser sous le seuil ferme la liste sans appel.
    await input.fill("12")
    await wait(500)
    assert.equal(await input.getAttribute("aria-expanded"), "false")
    assert.equal(env.ign.requests.length, 1)
  })

  await scenario("Requête : seulement text/type/maximumResponses, sans cookie ni referer", label, async () => {
    const r = env.ign.requests[0]
    assert.deepEqual([...r.url.searchParams.keys()].sort(), ["maximumResponses", "text", "type"])
    assert.equal(r.url.searchParams.get("type"), "StreetAddress")
    assert.equal(r.url.searchParams.get("maximumResponses"), "5")
    assert.equal(r.headers.cookie, undefined)
    assert.equal(r.headers.referer, undefined)
  })

  await scenario("Frappe rapide : un seul appel 300 ms après la dernière frappe", label, async () => {
    await fresh()
    const input = addressIn("client-create")
    await input.click()
    const t0 = Date.now()
    await input.pressSequentially("12 rue de rivoli", { delay: 40 })
    const typedAt = Date.now()
    await sec("client-create").locator('ul[role="listbox"] [role="option"]').first().waitFor()
    assert.equal(env.ign.requests.length, 1, `requêtes : ${env.ign.requests.map((r) => r.url.searchParams.get("text")).join(", ")}`)
    assert.equal(env.ign.requests[0].url.searchParams.get("text"), "12 rue de rivoli")
    assert.ok(env.ign.requests[0].at - typedAt >= 250, `délai ${env.ign.requests[0].at - typedAt} ms`)
    void t0
  })

  await scenario("Affichage : 5 max, numéro + voie, code postal + commune", label, async () => {
    const opts = sec("client-create").locator('ul[role="listbox"] [role="option"]')
    assert.equal(await opts.count(), 3)
    const first = await opts.first().innerText()
    assert.match(first, /12 Rue de Rivoli/)
    assert.match(first, /75001 Paris/)
  })

  await scenario("Réponse obsolète ignorée (requête lente puis frappe)", label, async () => {
    await fresh()
    const input = addressIn("client-create")
    env.ign.delayFor = { text: "rue lente", ms: 1500 }
    await input.click()
    await input.pressSequentially("rue lente")
    await wait(450) // la requête « rue lente » est partie et attend
    await input.pressSequentially(" bis")
    await sec("client-create").locator('ul[role="listbox"] [role="option"]').first().waitFor()
    await wait(1600) // la réponse lente arrive (ou est annulée)
    const texts = await sec("client-create").locator('ul[role="listbox"] [role="option"]').allInnerTexts()
    assert.ok(texts.some((t) => t.includes("Rue rue lente bis")), texts.join(" / "))
    assert.ok(!texts.some((t) => /Rue rue lente,|Rue rue lente\n/.test(t)), texts.join(" / "))
    env.ign.delayFor = null
  })

  await scenario(`Création client : sélection au ${touch ? "toucher" : "clic"} puis enregistrement`, label, async () => {
    await fresh()
    const s = sec("client-create")
    await s.getByLabel(/Nom/).first().fill("Client Test")
    const input = addressIn("client-create")
    await input.click()
    await input.pressSequentially("12 rue de rivoli")
    await pick(env.page, s, touch, 1)
    assert.equal(await input.inputValue(), "12 Rue de Rivoli, 93100 Montreuil")
    assert.equal(await input.getAttribute("aria-expanded"), "false")
    // Le champ reste modifiable après sélection.
    await input.press("End")
    await input.pressSequentially(" (bât. B)")
    await wait(400)
    await input.press("Escape")
    await s.getByRole("button", { name: "Créer le client" }).click()
    await env.page.waitForFunction(() => window.__calls.length > 0)
    const c = (await calls(env.page))[0]
    assert.equal(c.action, "createClient")
    assert.equal(c.fields.address, "12 Rue de Rivoli, 93100 Montreuil (bât. B)")
  })

  await scenario("Modification client : sélection au clavier (↓ ↓ Entrée) sans soumettre", label, async () => {
    await fresh()
    const s = sec("client-edit")
    const input = addressIn("client-edit")
    assert.equal(await input.inputValue(), "Place de la Mairie, 11170 Alzonne")
    await input.click()
    await input.fill("")
    await input.pressSequentially("12 rue de rivoli")
    await s.locator('ul[role="listbox"] [role="option"]').first().waitFor()
    await input.press("ArrowDown")
    await input.press("ArrowDown")
    assert.equal(await input.getAttribute("aria-activedescendant"), (await s.locator('ul[role="listbox"] [role="option"]').nth(1).getAttribute("id")))
    await input.press("Enter")
    assert.equal(await input.inputValue(), "12 Rue de Rivoli, 93100 Montreuil")
    await wait(200)
    assert.equal((await calls(env.page)).length, 0, "Entrée sur une suggestion ne doit pas soumettre")
    await s.getByRole("button", { name: "Enregistrer les modifications" }).click()
    await env.page.waitForFunction(() => window.__calls.length > 0)
    const c = (await calls(env.page))[0]
    assert.equal(c.action, "updateClient")
    assert.equal(c.id, "c1")
    assert.equal(c.fields.address, "12 Rue de Rivoli, 93100 Montreuil")
  })

  await scenario("Création chantier : adresse du chantier uniquement (client inchangé)", label, async () => {
    await fresh()
    const s = sec("chantier-create")
    await s.locator("#name").fill("Chantier Test")
    await s.locator("#endDate").fill("2026-12-31")
    const input = s.locator("#address")
    await input.click()
    await input.pressSequentially("12 rue de rivoli")
    await pick(env.page, s, touch, 0)
    assert.equal(await input.inputValue(), "12 Rue de Rivoli, 75001 Paris")
    await s.getByRole("button", { name: /Créer le chantier/ }).click()
    await env.page.waitForFunction(() => window.__calls.length > 0)
    const all = await calls(env.page)
    assert.deepEqual(all.map((c) => c.action), ["createChantierWithId"])
    assert.equal(all[0].fields.address, "12 Rue de Rivoli, 75001 Paris")
    assert.equal(all[0].fields.clientId, "c1")
  })

  await scenario("Création rapide d'un client depuis le formulaire chantier", label, async () => {
    await fresh()
    const s = sec("chantier-create")
    await s.getByRole("button", { name: /Ajouter un client/ }).click()
    const dialog = env.page.getByRole("dialog")
    await dialog.waitFor()
    await dialog.getByLabel(/Nom/).first().fill("Client Rapide")
    const input = dialog.locator('input[role="combobox"]')
    await input.click()
    await input.pressSequentially("12 rue de rivoli")
    await pick(env.page, dialog, touch, 2)
    assert.equal(await input.inputValue(), "Rue 12 rue de rivoli, 11170 Alzonne")
    assert.equal(await dialog.isVisible(), true, "le dialogue reste ouvert après la sélection")
    await dialog.getByRole("button", { name: "Créer le client" }).click()
    await env.page.waitForFunction(() => window.__calls.length > 0)
    const c = (await calls(env.page))[0]
    assert.equal(c.action, "createClient")
    assert.equal(c.fields.address, "Rue 12 rue de rivoli, 11170 Alzonne")
    assert.equal((await env.page.locator("#address").inputValue()), "", "l'adresse du chantier n'est pas touchée")
  })

  await scenario("Modification chantier : met à jour l'adresse du chantier uniquement", label, async () => {
    await fresh()
    const s = sec("chantier-edit")
    await s.getByRole("button", { name: /Modifier/ }).click()
    const input = s.locator('input[role="combobox"]')
    assert.equal(await input.inputValue(), "Rue du Boulodrome, 11170 Alzonne")
    await input.click()
    await input.fill("")
    await input.pressSequentially("12 rue de rivoli")
    await pick(env.page, s, touch, 0)
    await s.getByRole("button", { name: /Enregistrer/ }).click()
    await env.page.waitForFunction(() => window.__calls.length > 0)
    const all = await calls(env.page)
    assert.deepEqual(all.map((c) => c.action), ["updateChantier"])
    assert.equal(all[0].id, "w1")
    assert.equal(all[0].fields.address, "12 Rue de Rivoli, 75001 Paris")
    assert.equal(all[0].fields.clientId, "c1")
  })

  for (const [mode, message] of [
    ["network", "Suggestions indisponibles"],
    ["500", "Suggestions indisponibles"],
    ["429", "Trop de recherches"],
    ["empty", "Aucune adresse trouvée"],
    ["slow", "Suggestions trop lentes"],
  ]) {
    await scenario(`API indisponible (${mode}) : message + saisie et enregistrement manuels`, label, async () => {
      await fresh()
      env.ign.mode = mode
      const s = sec("chantier-edit")
      await s.getByRole("button", { name: /Modifier/ }).click()
      const input = s.locator('input[role="combobox"]')
      await input.click()
      await input.fill("")
      await input.pressSequentially("3 impasse inconnue 11170 Alzonne")
      await s.getByText(message).waitFor({ timeout: 7000 })
      await input.press("Enter") // aucune suggestion surlignée : Entrée soumet normalement
      await env.page.waitForFunction(() => window.__calls.length > 0)
      const c = (await calls(env.page))[0]
      assert.equal(c.action, "updateChantier")
      assert.equal(c.fields.address, "3 impasse inconnue 11170 Alzonne")
    })
  }

  if (env.errors.length) results.push({ device: label, name: "Erreurs JavaScript", ok: false, error: env.errors.join(" | ") })
  // Capture d'écran pour la revue visuelle.
  await fresh()
  const input = addressIn("client-create")
  await input.click()
  await input.pressSequentially("12 rue de rivoli")
  await sec("client-create").locator('ul[role="listbox"] [role="option"]').first().waitFor()
  await sec("client-create").screenshot({ path: path.join(dir, `autocomplete-${label}.png`) })
  await env.context.close()
}

;(async () => {
  const browser = await chromium.launch()
  await runDevice(browser, "ordinateur", { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 }, false)
  await runDevice(browser, "mobile", { ...devices["iPhone 13"] }, true)
  await browser.close()
  for (const r of results) console.log(`${r.ok ? "✔" : "✘"} [${r.device}] ${r.name}${r.ok ? "" : `\n    ${r.error}`}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} scénarios réussis`)
  process.exit(failed ? 1 : 0)
})()
