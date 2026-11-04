/**
 * Véhicules V3 — lecture des pièces avant ajout : règles par rubrique, route (drapeau, droits, entreprise, bornes,
 * aucune écriture, aucune journalisation), fusion dans le formulaire et réponses périmées.
 * Pièces entièrement synthétiques : noms, plaques, numéros et adresses fictifs ; aucune donnée réelle.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import sharp from "sharp"
import { POST as recognizePost } from "@/app/api/trucks/[id]/documents/recognize/route"
import { extractVehicleDocumentFields, normalizeText, plateKey, type RecognitionProposal } from "@/lib/vehicules/v3/document-recognition-domain"
import { runningRecognitions, type DocumentReader } from "@/lib/vehicules/v3/document-recognition-service"
import { readDocument, shutdownOcr, type Reading } from "@/lib/hr-documents/recognition/ocr"
import { applyRecognition, createLatestOnly, recognitionChecks, recognitionSummary, resetUntouched } from "@/components/vehicules/v3/vehicle-document-recognition-ui"
import { jpegPdf } from "../../hr-documents/ocr/fixtures"
import { ADMIN, LEADER, OTHER_ADMIN, PDF_BYTES, PNG_BYTES, TRUCK, V3MemoryDb } from "./v3-test-db"

const truck = { matricule: "AB-123-CD", marque: "Renault" }

const REGISTRATION = `CERTIFICAT D'IMMATRICULATION
A AB-123-CD B 12/03/2021
C.1 EXEMPLE TRANSPORTS SAS
C.3 12 RUE DE L'EXEMPLE 00000 NULLE-PART
D.1 RENAULT TRUCKS D.3 MASTER
I 16/10/2026
2026EE28718`
const INSURANCE = `ATTESTATION D'ASSURANCE
AXA FRANCE IARD
Contrat n° 1234567 89
Véhicule assuré : AB-123-CD
Période de validité : du 01/01/2026 au 31/12/2026
Fait le 15/12/2025`
const GREEN_CARD = `CARTE INTERNATIONALE D'ASSURANCE AUTOMOBILE
Valable du/from 01/04/2026 au/to 31/03/2027
Assureur : MUTUELLE FICTIVE DU NORD
N° de police : POL-778899`
const INSPECTION = `PROCÈS-VERBAL DE CONTRÔLE TECHNIQUE
Centre : AUTOSUR EXEMPLEVILLE
N° de PV : PV-2026-0042
Date du contrôle : 02/02/2026
Immatriculation AB123CD
Kilométrage relevé : 118 400 km
Date limite de validité : 01/02/2027`
const GARAGE_INVOICE = `GARAGE EXEMPLE AUTOMOBILES
12 avenue Fictive 00000 Nulle-Part
SIRET 000 000 000 00000
FACTURE N° F2026-0153
Date : 03/03/2026
Véhicule : AB-123-CD Kilométrage : 120 512
Vidange + filtre 89,90
Total HT 150,00
TVA 20 % 30,00
Total TTC 180,00`
const FUEL_TICKET = `TOTALENERGIES
STATION EXEMPLE A86
LE 04/11/26 A 07:42
TICKET N° 004521
GAZOLE 52,31 L
PRIX/L 1,689 EUR
MONTANT 88,35 EUR
KM 120 900`

const values = (proposal: Pick<RecognitionProposal, "fields">) => Object.fromEntries(Object.entries(proposal.fields).map(([key, field]) => [key, field!.value]))

describe("règles d'extraction par rubrique (textes synthétiques)", () => {
  it("carte grise : date I, titulaire C.1 à vérifier, numéro de formule ; plaque et marque contrôlées ; adresse jamais lue", () => {
    const p = extractVehicleDocumentFields({ category: "REGISTRATION", text: REGISTRATION, truck })
    assert.deepEqual(values(p), { issuedOn: "2026-10-16", issuerName: "EXEMPLE TRANSPORTS SAS", referenceNumber: "2026EE28718" })
    assert.equal(p.fields.issuerName!.confidence, "TO_CHECK")
    assert.equal(p.fields.issuedOn!.confidence, "READ")
    assert.deepEqual(p.observations, ["1re immatriculation (B) : 12/03/2021"])
    assert.deepEqual(p.checks.map((c) => [c.kind, c.outcome]), [["PLATE", "MATCH"], ["BRAND", "MATCH"]])
    assert.equal(p.otherCategory, null)
    assert.doesNotMatch(JSON.stringify(p), /RUE|NULLE|00000/)
  })
  it("carte grise : marque différente de la fiche → alerte et ligne d'observation ; plaque d'un autre véhicule → alerte", () => {
    const p = extractVehicleDocumentFields({ category: "REGISTRATION", text: REGISTRATION.replace("AB-123-CD", "ZZ-999-ZZ"), truck: { matricule: "AB-123-CD", marque: "Iveco" } })
    assert.deepEqual(p.checks.map((c) => [c.kind, c.outcome, c.read]), [["PLATE", "MISMATCH", "ZZ-999-ZZ"], ["BRAND", "MISMATCH", "RENAULT TRUCKS"]])
    assert.ok(p.observations.includes("Marque lue (D.1) : RENAULT TRUCKS"))
  })
  it("carte grise : aucune date d'échéance n'est proposée (la rubrique n'en a pas)", () => {
    const p = extractVehicleDocumentFields({ category: "REGISTRATION", text: `${REGISTRATION}\nValable du 01/01/2026 au 31/12/2026`, truck })
    assert.equal(p.fields.validUntil, undefined); assert.equal(p.fields.validFrom, undefined)
  })
  it("attestation d'assurance : assureur connu, contrat, période du … au …, date d'émission", () => {
    const p = extractVehicleDocumentFields({ category: "INSURANCE", text: INSURANCE, truck })
    assert.deepEqual(values(p), { validFrom: "2026-01-01", validUntil: "2026-12-31", issuedOn: "2025-12-15", issuerName: "AXA", referenceNumber: "1234567 89" })
    assert.equal(p.checks[0].outcome, "MATCH")
  })
  it("carte verte : « du/from … au/to … », assureur libellé à vérifier, numéro de police", () => {
    const p = extractVehicleDocumentFields({ category: "INSURANCE", text: GREEN_CARD, truck })
    assert.equal(p.fields.validFrom!.value, "2026-04-01"); assert.equal(p.fields.validUntil!.value, "2027-03-31")
    assert.deepEqual([p.fields.issuerName!.value, p.fields.issuerName!.confidence], ["MUTUELLE FICTIVE DU NORD", "TO_CHECK"])
    assert.equal(p.fields.referenceNumber!.value, "POL-778899")
  })
  it("contrôle technique : date, échéance, centre, PV ; kilométrage en observation (pas de champ dédié)", () => {
    const p = extractVehicleDocumentFields({ category: "TECHNICAL_INSPECTION", text: INSPECTION, truck })
    assert.deepEqual(values(p), { issuedOn: "2026-02-02", validUntil: "2027-02-01", issuerName: "AUTOSUR EXEMPLEVILLE", referenceNumber: "PV-2026-0042" })
    assert.deepEqual(p.observations, ["Kilométrage relevé au contrôle : 118 400 km"])
    assert.equal(p.checks[0].outcome, "MATCH")
  })
  it("facture de garage : fournisseur d'en-tête à vérifier, numéro, date, kilométrage ; montant TTC (pas le HT) en observation", () => {
    const p = extractVehicleDocumentFields({ category: "REPAIR_MAINTENANCE", text: GARAGE_INVOICE, truck })
    assert.deepEqual(values(p), { issuedOn: "2026-03-03", issuerName: "GARAGE EXEMPLE AUTOMOBILES", referenceNumber: "F2026-0153", mileage: 120512 })
    assert.equal(p.fields.mileage!.confidence, "TO_CHECK")
    assert.deepEqual(p.observations, ["Montant TTC lu : 180,00 €"])
  })
  it("ticket de carburant : enseigne, date à deux chiffres, ticket, kilométrage, montant et litres", () => {
    const p = extractVehicleDocumentFields({ category: "EXPENSE_RECEIPT", text: FUEL_TICKET, truck })
    assert.deepEqual(values(p), { issuedOn: "2026-11-04", issuerName: "TOTALENERGIES", referenceNumber: "004521", mileage: 120900 })
    assert.deepEqual(p.observations, ["Montant TTC lu : 88,35 €", "Volume lu : 52,31 L"])
  })
  it("document d'une autre rubrique : signalé, jamais reclassé", () => {
    const p = extractVehicleDocumentFields({ category: "INSURANCE", text: REGISTRATION, truck })
    assert.equal(p.category, "INSURANCE"); assert.equal(p.otherCategory, "REGISTRATION")
  })
  it("lecture OCR peu sûre : toutes les valeurs passent « à vérifier »", () => {
    const p = extractVehicleDocumentFields({ category: "INSURANCE", text: INSURANCE, truck, lowConfidence: true })
    assert.ok(Object.values(p.fields).every((field) => field!.confidence === "TO_CHECK"))
  })
  it("texte quelconque, vide ou hostile : aucune proposition, aucune exception ; dates impossibles refusées", () => {
    for (const text of ["", "lorem ipsum dolor", "\u0000\u0001".repeat(50), "A".repeat(100_000), "Date : 31/02/2026\nFait le 00/13/2026"]) {
      const p = extractVehicleDocumentFields({ category: "INSURANCE", text, truck })
      assert.equal(p.fields.issuedOn, undefined); assert.equal(p.fields.validFrom, undefined)
    }
    assert.equal(normalizeText("Contrôle  technique é").join(), "CONTROLE TECHNIQUE E")
    assert.equal(plateKey("ab-123 cd"), "AB123CD")
  })
})

// ─── Route ───────────────────────────────────────────────────────────────────

const ORIGIN = "https://vehicles-tests.invalid"
const params = { params: Promise.resolve({ id: TRUCK }) }
function request(payload: unknown, file: { name: string; type: string; bytes: Uint8Array } = { name: "scan.pdf", type: "application/pdf", bytes: PDF_BYTES }, origin = ORIGIN) {
  const body = new FormData()
  body.set("payload", JSON.stringify(payload))
  body.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }), file.name)
  return new Request(`${ORIGIN}/api/trucks/${TRUCK}/documents/recognize`, { method: "POST", headers: { host: "vehicles-tests.invalid", origin }, body })
}
const reading = (text: string, over: Partial<Reading> = {}): Reading => ({ text, status: "TEXT_LAYER", reason: null, durationMs: 12, pages: 1, rotation: null, confidence: null, mrzFound: false, ...over })
function depsFor(db: V3MemoryDb, session = ADMIN, read: DocumentReader = async () => reading(REGISTRATION)) {
  const calls: { kind: string; timeoutMs: number }[] = []
  const deps = { ...db.deps(session), env: { ...process.env, PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED: "true" }, read: (async (bytes, kind, opts) => { calls.push({ kind, timeoutMs: opts.timeoutMs }); return read(bytes, kind, opts) }) as DocumentReader }
  return { deps, calls }
}
const writes = (db: V3MemoryDb) => db.calls.filter((c) => /\.(create|update|updateMany|upsert|delete)/.test(c.operation))

describe("route de lecture : drapeau, droits, entreprise, bornes, aucune écriture", () => {
  let savedV3: string | undefined
  before(() => { savedV3 = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (savedV3 === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedV3 })

  it("drapeau absent : 404 sans toucher la base ni lire le fichier", async () => {
    const db = new V3MemoryDb()
    const { deps, calls } = depsFor(db)
    const response = await recognizePost(request({ category: "REGISTRATION" }), params, { ...deps, env: { ...process.env, PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED: undefined } })
    assert.equal(response.status, 404); assert.equal((await response.json()).code, "RECOGNITION_DISABLED")
    assert.equal(db.calls.length, 0); assert.equal(calls.length, 0)
  })
  it("prototype V3 éteint : 404 même drapeau de lecture allumé", async () => {
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "false"
    try {
      const db = new V3MemoryDb()
      const response = await recognizePost(request({ category: "REGISTRATION" }), params, depsFor(db).deps)
      assert.equal(response.status, 404); assert.equal((await response.json()).code, "FEATURE_DISABLED")
    } finally { process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" }
  })
  it("administrateur : proposition sans texte brut ni adresse, en-têtes privés, aucune écriture, délai transmis", async () => {
    const db = new V3MemoryDb()
    const { deps, calls } = depsFor(db)
    const response = await recognizePost(request({ category: "REGISTRATION" }), params, deps)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("Cache-Control"), "private, no-store")
    const body = await response.json() as RecognitionProposal
    assert.deepEqual(Object.keys(body).sort(), ["category", "checks", "fields", "observations", "otherCategory", "reading"])
    assert.equal(body.fields.referenceNumber!.value, "2026EE28718")
    assert.deepEqual(Object.keys(body.reading).sort(), ["durationMs", "pages", "reason", "status"])
    assert.doesNotMatch(JSON.stringify(body), /RUE DE L|CERTIFICAT D'IMMATRICULATION/)
    assert.deepEqual(calls, [{ kind: "pdf", timeoutMs: 25_000 }])
    assert.deepEqual(writes(db), [])
    assert.equal(runningRecognitions(), 0)
  })
  it("chef d'équipe : 403 ; administrateur d'une autre entreprise : 404 ; fichier jamais lu", async () => {
    for (const [session, status] of [[LEADER, 403], [OTHER_ADMIN, 404]] as const) {
      const db = new V3MemoryDb()
      const { deps, calls } = depsFor(db, session)
      const response = await recognizePost(request({ category: "INSURANCE" }), params, deps)
      assert.equal(response.status, status); assert.equal(calls.length, 0)
    }
  })
  it("véhicule archivé : 409 ; origine étrangère : 403 ; rubrique inconnue ou champ en trop : 400", async () => {
    const db = new V3MemoryDb()
    db.state.trucks[0].active = false
    assert.equal((await recognizePost(request({ category: "INSURANCE" }), params, depsFor(db).deps)).status, 409)
    const fresh = new V3MemoryDb()
    assert.equal((await recognizePost(request({ category: "INSURANCE" }, undefined, "https://evil.invalid"), params, depsFor(fresh).deps)).status, 403)
    assert.equal((await recognizePost(request({ category: "PASSPORT" }), params, depsFor(fresh).deps)).status, 400)
    assert.equal((await recognizePost(request({ category: "INSURANCE", title: "x" }), params, depsFor(fresh).deps)).status, 400)
  })
  it("fichier refusé avant toute lecture : type déclaré faux, extension trompeuse, PDF actif, taille", async () => {
    const db = new V3MemoryDb()
    const { deps, calls } = depsFor(db)
    const cases = [
      { name: "scan.pdf", type: "application/pdf", bytes: PNG_BYTES },
      { name: "scan.png", type: "image/png", bytes: PDF_BYTES },
      { name: "scan.pdf", type: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<< /OpenAction << /S /JavaScript >> >>endobj\n%%EOF\n", "latin1")) },
      { name: "scan.pdf", type: "application/pdf", bytes: new Uint8Array(4 * 1024 * 1024 + 1) },
    ]
    for (const file of cases) assert.ok([413, 415].includes((await recognizePost(request({ category: "INSURANCE" }, file), params, deps)).status))
    assert.equal(calls.length, 0)
  })
  it("une lecture à la fois par instance : la seconde reçoit 429, la place se libère à la fin réelle", async () => {
    const db = new V3MemoryDb()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { deps } = depsFor(db, ADMIN, async () => { await gate; return reading(INSURANCE) })
    const first = recognizePost(request({ category: "INSURANCE" }), params, deps)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await recognizePost(request({ category: "INSURANCE" }), params, deps)
    assert.equal(second.status, 429); assert.equal((await second.json()).code, "RECOGNITION_BUSY")
    release()
    assert.equal((await first).status, 200)
    assert.equal(runningRecognitions(), 0)
  })
  it("échec du lecteur : 502 sans détail ; lecture technique échouée : 200 sans champ", async () => {
    const db = new V3MemoryDb()
    const failed = await recognizePost(request({ category: "INSURANCE" }), params, depsFor(db, ADMIN, async () => { throw new Error("SECRET-EXEMPLE wasm") }).deps)
    assert.equal(failed.status, 502)
    assert.doesNotMatch(JSON.stringify(await failed.json()), /SECRET|wasm/)
    const empty = await recognizePost(request({ category: "INSURANCE" }), params, depsFor(db, ADMIN, async () => reading("", { status: "TECHNICAL_FAILURE", reason: "OCR_ERROR" })).deps)
    const body = await empty.json() as RecognitionProposal
    assert.deepEqual([empty.status, body.fields, body.reading.status, body.reading.reason], [200, {}, "TECHNICAL_FAILURE", "OCR_ERROR"])
    assert.equal(runningRecognitions(), 0)
  })
  it("aucune valeur lue n'est journalisée", async () => {
    const logged: string[] = []
    const methods = ["log", "info", "warn", "error", "debug"] as const
    const original = methods.map((m) => console[m])
    methods.forEach((m) => { console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")) } })
    try {
      const db = new V3MemoryDb()
      for (const [category, text] of [["REGISTRATION", REGISTRATION], ["INSURANCE", INSURANCE], ["EXPENSE_RECEIPT", FUEL_TICKET]] as const)
        await recognizePost(request({ category }), params, depsFor(db, ADMIN, async () => reading(text)).deps)
      await recognizePost(request({ category: "INSURANCE" }), params, depsFor(db, ADMIN, async () => { throw new Error("EXEMPLE TRANSPORTS") }).deps)
    } finally { methods.forEach((m, i) => { console[m] = original[i] }) }
    assert.doesNotMatch(logged.join("\n"), /EXEMPLE|2026EE28718|AXA|1234567|TOTALENERGIES|004521/)
  })
})

// ─── Formulaire ──────────────────────────────────────────────────────────────

const EMPTY = { title: "Assurance", issuedOn: "", validFrom: "", validUntil: "", issuerName: "", referenceNumber: "", observations: "", mileage: "", maintenanceEntryId: "" }
const proposalFor = (category: RecognitionProposal["category"], text: string): RecognitionProposal =>
  ({ ...extractVehicleDocumentFields({ category, text, truck }), reading: { status: "TEXT_LAYER", reason: null, pages: 1, durationMs: 840 } })

describe("formulaire : préremplissage sans écraser les saisies", () => {
  it("remplit les champs vides de la rubrique et marque leur confiance", () => {
    const { form, filled } = applyRecognition(EMPTY, new Set(), proposalFor("INSURANCE", INSURANCE), "INSURANCE")
    assert.deepEqual([form.validFrom, form.validUntil, form.issuerName, form.referenceNumber, form.issuedOn], ["2026-01-01", "2026-12-31", "AXA", "1234567 89", "2025-12-15"])
    assert.equal(form.title, "Assurance")
    assert.deepEqual(filled, { issuedOn: "READ", validFrom: "READ", validUntil: "READ", issuerName: "READ", referenceNumber: "READ" })
  })
  it("un champ saisi à la main n'est jamais réécrit, même vide", () => {
    const typed = { ...EMPTY, issuerName: "Mon assureur", validUntil: "" }
    const { form, filled } = applyRecognition(typed, new Set(["issuerName", "validUntil"]), proposalFor("INSURANCE", INSURANCE), "INSURANCE")
    assert.equal(form.issuerName, "Mon assureur"); assert.equal(form.validUntil, "")
    assert.equal(filled.issuerName, undefined); assert.equal(filled.validUntil, undefined)
  })
  it("remplacement : les valeurs de la version précédente cèdent la place au nouveau fichier ; observations complétées", () => {
    const previous = { ...EMPTY, validFrom: "2025-01-01", validUntil: "2025-12-31", observations: "Franchise 300 €" }
    const { form } = applyRecognition(previous, new Set(), proposalFor("REPAIR_MAINTENANCE", GARAGE_INVOICE), "REPAIR_MAINTENANCE")
    assert.equal(form.observations, "Franchise 300 €\nMontant TTC lu : 180,00 €")
    assert.equal(form.mileage, "120512")
    const again = applyRecognition(form, new Set(), proposalFor("REPAIR_MAINTENANCE", GARAGE_INVOICE), "REPAIR_MAINTENANCE")
    assert.equal(again.form.observations, form.observations)
  })
  it("proposition d'une autre rubrique (formulaire rouvert entre-temps) : ignorée", () => {
    const { form, filled } = applyRecognition(EMPTY, new Set(), proposalFor("INSURANCE", INSURANCE), "REGISTRATION")
    assert.deepEqual(form, EMPTY); assert.deepEqual(filled, {})
  })
  it("nouveau fichier : les champs non saisis reprennent leur valeur d'ouverture, les saisies restent", () => {
    const initial = { ...EMPTY, validFrom: "2025-01-01" }
    const afterFirst = { ...initial, validFrom: "2026-01-01", validUntil: "2026-12-31", issuerName: "Saisi" }
    assert.deepEqual(resetUntouched(afterFirst, new Set(["issuerName"]), initial), { ...initial, issuerName: "Saisi" })
  })
  it("réponse périmée : seul le dernier jeton est appliqué ; fermeture du formulaire = annulation", () => {
    const latest = createLatestOnly()
    const first = latest.start()
    const second = latest.start()
    assert.equal(first.signal.aborted, true); assert.equal(latest.isCurrent(first.token), false); assert.equal(latest.isCurrent(second.token), true)
    latest.cancel()
    assert.equal(second.signal.aborted, true); assert.equal(latest.isCurrent(second.token), false)
  })
  it("messages : synthèse, contrôle de plaque, rubrique douteuse, lecture impossible", () => {
    const p = proposalFor("INSURANCE", REGISTRATION.replace("AB-123-CD", "ZZ-999-ZZ"))
    assert.match(recognitionSummary(p, 2).text, /2 informations préremplies \(texte du PDF, 0,8 s\)\. Vérifiez chaque champ/)
    assert.deepEqual(recognitionChecks(p).map((c) => c.tone), ["warning", "warning"])
    assert.match(recognitionChecks(p)[1].text, /Carte grise/)
    assert.equal(recognitionSummary({ ...p, reading: { ...p.reading, status: "ENGINE_MISSING" } }, 0).tone, "warning")
  })
})

// ─── Lecture réelle (Tesseract local, image synthétique) ─────────────────────

async function syntheticRegistrationJpeg() {
  const lines = ["CERTIFICAT D'IMMATRICULATION", "A  AB-123-CD     B  12/03/2021", "C.1  EXEMPLE TRANSPORTS SAS", "D.1  RENAULT", "I  16/10/2026", "2026EE28718"]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="800"><rect width="100%" height="100%" fill="#ffffff"/>${lines.map((line, i) => `<text x="70" y="${110 + i * 110}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="54" fill="#111">${line.replace(/'/g, "&apos;")}</text>`).join("")}</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true })
}

describe("lecture réelle d'un scan synthétique (OCR local, aucun réseau)", () => {
  after(() => shutdownOcr())
  it("photo JPEG puis scan PDF de carte grise fictive : formule, date I et plaque reconnues", { timeout: 120_000 }, async () => {
    const { data, info } = await syntheticRegistrationJpeg()
    for (const [kind, bytes] of [["jpeg", new Uint8Array(data)], ["pdf", jpegPdf(data, info.width, info.height)]] as const) {
      const r = await readDocument(bytes, kind, { timeoutMs: 60_000 })
      assert.equal(r.status, "OCR", `${kind}: ${r.status} ${r.reason}`)
      const p = extractVehicleDocumentFields({ category: "REGISTRATION", text: r.text, truck })
      assert.equal(p.fields.referenceNumber?.value, "2026EE28718", kind)
      assert.equal(p.fields.issuedOn?.value, "2026-10-16", kind)
      assert.equal(p.checks.find((c) => c.kind === "PLATE")?.outcome, "MATCH", kind)
    }
  })
  it("photo floue et tournée d'attestation fictive : période et assureur reconnus", { timeout: 120_000 }, async () => {
    const lines = ["ATTESTATION D'ASSURANCE", "AXA FRANCE IARD", "Contrat n° 1234567", "Vehicule assure : AB-123-CD", "Periode de validite : du 01/01/2026 au 31/12/2026"]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="700"><rect width="100%" height="100%" fill="#f4f1ea"/>${lines.map((line, i) => `<text x="60" y="${110 + i * 110}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="46" fill="#222">${line.replace(/'/g, "&apos;")}</text>`).join("")}</svg>`
    const photo = await sharp(Buffer.from(svg)).blur(1.2).rotate(90).jpeg({ quality: 70 }).toBuffer()
    const r = await readDocument(new Uint8Array(photo), "jpeg", { timeoutMs: 60_000 })
    assert.equal(r.status, "OCR")
    const p = extractVehicleDocumentFields({ category: "INSURANCE", text: r.text, truck, lowConfidence: (r.confidence ?? 0) < 70 })
    assert.equal(p.fields.validFrom?.value, "2026-01-01"); assert.equal(p.fields.validUntil?.value, "2026-12-31")
    assert.equal(p.fields.issuerName?.value, "AXA")
  })
})
