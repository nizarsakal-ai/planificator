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
import { abandonedRecognitions, recognizeVehicleDocument, runningRecognitions, type DocumentReader } from "@/lib/vehicules/v3/document-recognition-service"
import { createVehicleOcrEngine, type VehicleOcrEngine } from "@/lib/vehicules/v3/document-recognition-engine"
import { declaredPdfImagePixels, readDocument, shutdownOcr, type OcrEngine, type OcrEngineHandle, type Reading } from "@/lib/hr-documents/recognition/ocr"
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
    // « MONTANT » seul ne prouve pas le TTC (R2) : montant qualifié, à vérifier.
    assert.deepEqual(p.observations, ["Montant total lu (TTC non indiqué, à vérifier) : 88,35 €", "Volume lu : 52,31 L"])
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

// ═══ R2 — contre-exemples de la revue Codex (textes et fichiers synthétiques) ═══

const ADDRESS_LEAK = /RUE|AVENUE|AV FICTIVE|BOULEVARD|NULLE|00000|12 (?:RUE|AV)|CEDEX/
const grey = async (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } }).png().toBuffer()

describe("R2 point 4 — titulaire C.1 : jamais l'adresse C.3, quelle que soit la ponctuation", () => {
  const registration = (holderLine: string) => `CERTIFICAT D'IMMATRICULATION\nA AB-123-CD B 12/03/2021\n${holderLine}\nD.1 RENAULT TRUCKS D.3 MASTER\nI 16/10/2026\n2026EE28718`
  const cases: [string, string | null][] = [
    ["C.1 SOCIETE FICTIVE C.3: 12 RUE FICTIVE", "SOCIETE FICTIVE"],
    ["C.1 SOCIETE FICTIVE C.3 : 12 RUE FICTIVE", "SOCIETE FICTIVE"],
    ["C.1 SOCIETE FICTIVE C.3:12 RUE FICTIVE", "SOCIETE FICTIVE"],
    ["C.1 SOCIETE FICTIVE (C.3) 12 RUE FICTIVE", "SOCIETE FICTIVE"],
    ["C.1 SOCIETE FICTIVE C .3 12 RUE FICTIVE", "SOCIETE FICTIVE"],
    ["C.1 SOCIETE FICTIVE C,3 12 AV FICTIVE", "SOCIETE FICTIVE"],
    ["C.1 SOCIETE FICTIVEC.3:12 RUE FICTIVE", "SOCIETE FICTIVE"],
    ["C.1 SOCIETE FICTIVE C3 12 RUE FICTIVE", "SOCIETE FICTIVE"],
    ["(C.1) SOCIETE FICTIVE (C.3) 12 RUE FICTIVE 00000 NULLE-PART", "SOCIETE FICTIVE"],
    // Ligne OCR fusionnée : C.3 puis D.1 sur la même ligne que C.1.
    ["C.1 SOCIETE FICTIVE C.3 12 RUE FICTIVE 00000 NULLE-PART D.1 RENAULT", "SOCIETE FICTIVE"],
    // Ambigu : adresse sans code de rubrique (code C.3 perdu par l'OCR) : rien n'est proposé.
    ["C.1 SOCIETE FICTIVE 12 RUE FICTIVE 00000 NULLE-PART", null],
    ["C.1 SOCIETE FICTIVE 00000 NULLE-PART", null],
    ["C.1 12 RUE FICTIVE", null],
    ["C.1 C.3 12 RUE FICTIVE", null],
  ]
  for (const [line, expected] of cases) it(`« ${line} » → ${expected ?? "aucun titulaire"}`, () => {
    const p = extractVehicleDocumentFields({ category: "REGISTRATION", text: registration(line), truck })
    assert.equal(p.fields.issuerName?.value ?? null, expected)
    assert.doesNotMatch(JSON.stringify(p), ADDRESS_LEAK, "aucun fragment d'adresse dans toute la proposition")
  })
  it("marque D.1 suivie d'une adresse fusionnée : ni marque d'adresse ni fragment dans les observations", () => {
    const p = extractVehicleDocumentFields({ category: "REGISTRATION", text: registration("C.1 SOCIETE FICTIVE").replace("D.1 RENAULT TRUCKS D.3 MASTER", "D.1 IVECO C.3 12 RUE FICTIVE"), truck })
    assert.doesNotMatch(JSON.stringify(p), ADDRESS_LEAK)
    assert.ok(p.observations.includes("Marque lue (D.1) : IVECO"))
  })
  it("route : aucune adresse dans la réponse ni dans les journaux, pour chaque variante", async () => {
    let savedV3 = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED
    process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true"
    const logged: string[] = []
    const methods = ["log", "info", "warn", "error", "debug"] as const
    const original = methods.map((m) => console[m])
    methods.forEach((m) => { console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")) } })
    try {
      for (const [line] of cases) {
        const db = new V3MemoryDb()
        const response = await recognizePost(request({ category: "REGISTRATION" }), params, depsFor(db, ADMIN, async () => reading(registration(line))).deps)
        assert.equal(response.status, 200)
        assert.doesNotMatch(await response.text(), ADDRESS_LEAK, line)
      }
    } finally {
      methods.forEach((m, i) => { console[m] = original[i] })
      if (savedV3 === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedV3
      savedV3 = undefined
    }
    assert.doesNotMatch(logged.join("\n"), /FICTIVE|RUE|NULLE/)
  })
})

describe("R2 point 7 — montant TTC : jamais un HT ou une TVA de la ligne suivante", () => {
  const observation = (text: string) => extractVehicleDocumentFields({ category: "REPAIR_MAINTENANCE", text: `GARAGE EXEMPLE\n${text}`, truck }).observations.find((o) => o.startsWith("Montant")) ?? null
  const cases: [string, string | null][] = [
    ["TOTAL\nHT 100,00\nTVA 20,00", null],
    ["TOTAL\nH.T. 100,00", null],
    ["TOTAL\nTVA 20,00", null],
    ["TOTAL 100,00 HT", null],
    ["TOTAL (HT) 100,00", null],
    ["TOTAL HORS TAXES 100,00", null],
    ["TOTAL\nHT 100,00\nTOTAL TTC 120,00", "Montant TTC lu : 120,00 €"],
    ["TOTAL\nTTC 120,00", "Montant TTC lu : 120,00 €"],
    ["TOTAL 120,00 TTC", "Montant TTC lu : 120,00 €"],
    ["TOTAL TOUTES TAXES 120,00", "Montant TTC lu : 120,00 €"],
    ["NET A PAYER\n120,00", "Montant TTC lu : 120,00 €"],
    ["TOTAL 120,00", "Montant total lu (TTC non indiqué, à vérifier) : 120,00 €"],
    ["Total HT 100,00\nTVA 20 % 20,00\nTotal TTC 120,00", "Montant TTC lu : 120,00 €"],
  ]
  for (const [text, expected] of cases) it(`${JSON.stringify(text)} → ${expected ?? "aucun montant"}`, () => assert.equal(observation(text), expected))
})

/** Moteur factice : `recognize` reste en suspens jusqu'à `terminate`, qui le rejette (comme un worker tué). */
function hangingHandle(log: string[]): OcrEngineHandle {
  const pending: ((e: Error) => void)[] = []
  const engine: OcrEngine = { recognize: () => new Promise((_, reject) => { log.push("recognize"); pending.push(reject) }) }
  return { engine, terminate: async () => { log.push("terminate"); pending.splice(0).forEach((reject) => reject(new Error("worker terminated"))) } }
}
const quickHandle = (log: string[]): OcrEngineHandle => ({
  engine: { recognize: async () => { log.push("recognize-ok"); return { text: "ATTESTATION D'ASSURANCE AXA FRANCE IARD Contrat 1234567 periode du 01/01/2026 au 31/12/2026 vehicule AB-123-CD", confidence: 92, lines: [] } } },
  terminate: async () => { log.push("terminate-ok") },
})

describe("R2 point 3 — borne réelle de la lecture OCR : arrêt, libération, concurrence, reprise", () => {
  let savedV3: string | undefined
  before(() => { savedV3 = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (savedV3 === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedV3 })
  const pngFile = async () => ({ name: "photo.png", type: "image/png", bytes: new Uint8Array(await grey(400, 300)) })
  const withEngine = (db: V3MemoryDb, engine: VehicleOcrEngine, over: Record<string, unknown> = {}) =>
    ({ ...db.deps(ADMIN), env: { ...process.env, PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED: "true" }, engine, ...over })

  it("échéance : moteur véhicule arrêté (workers terminés), place rendue, seconde lecture 429 pendant, reprise avec un moteur rechargé", async () => {
    const log: string[] = []
    let made = 0
    const engine = createVehicleOcrEngine(async () => (made++ === 0 ? hangingHandle(log) : quickHandle(log)))
    const file = await pngFile()
    const started = Date.now()
    const first = recognizePost(request({ category: "INSURANCE" }, file), params, withEngine(new V3MemoryDb(), engine, { deadlineMs: 150, graceMs: 500 }) as never)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal((await recognizePost(request({ category: "INSURANCE" }, file), params, withEngine(new V3MemoryDb(), engine) as never)).status, 429)
    const response = await first
    assert.deepEqual([response.status, (await response.json()).code], [504, "RECOGNITION_TIMEOUT"])
    assert.ok(Date.now() - started < 2_000, "réponse bornée par l'échéance, pas par le moteur")
    assert.ok(log.includes("terminate"), "workers du moteur véhicule terminés")
    assert.deepEqual([runningRecognitions(), abandonedRecognitions(), engine.loaded()], [0, 0, false])
    const again = await recognizePost(request({ category: "INSURANCE" }, file), params, withEngine(new V3MemoryDb(), engine) as never)
    assert.equal(again.status, 200)
    assert.equal(made, 2, "reprise : moteur rechargé")
    assert.ok(log.includes("recognize-ok"))
    await engine.kill()
  })
  it("lecteur qui ignore l'abandon : place rendue après le délai de grâce, lecture comptée « abandonnée » ; au-delà de deux, 429 ; libéré à sa fin", async () => {
    const releases: (() => void)[] = []
    const stuck: DocumentReader = () => new Promise<Reading>((resolve) => { releases.push(() => resolve(reading(""))) })
    const engine = createVehicleOcrEngine(async () => quickHandle([]))
    const deps = (read: DocumentReader) => ({ ...depsFor(new V3MemoryDb(), ADMIN, read).deps, engine, deadlineMs: 60, graceMs: 30 })
    assert.equal((await recognizePost(request({ category: "INSURANCE" }), params, deps(stuck) as never)).status, 504)
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 1])
    assert.equal((await recognizePost(request({ category: "INSURANCE" }), params, deps(async () => reading(INSURANCE)) as never)).status, 200)
    assert.equal((await recognizePost(request({ category: "INSURANCE" }), params, deps(stuck) as never)).status, 504)
    assert.equal(abandonedRecognitions(), 2)
    assert.equal((await recognizePost(request({ category: "INSURANCE" }), params, deps(async () => reading(INSURANCE)) as never)).status, 429)
    releases.forEach((release) => release())
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 0])
    assert.equal((await recognizePost(request({ category: "INSURANCE" }), params, deps(async () => reading(INSURANCE)) as never)).status, 200)
  })
  // R3 : le lecteur par défaut est désormais le processus isolé (tests/vehicules/v3/ocr-isolation.test.ts) ; ce test
  // couvre le mode « dans le serveur » qui ne subsiste que par injection d'un moteur.
  it("moteur injecté (mode dans le serveur) : moteur dédié aux pièces véhicule, jamais le moteur partagé des documents RH", async () => {
    const log: string[] = []
    const engine = createVehicleOcrEngine(async () => quickHandle(log))
    const response = await recognizePost(request({ category: "INSURANCE" }, await pngFile()), params, withEngine(new V3MemoryDb(), engine) as never)
    assert.equal(response.status, 200)
    assert.ok(log.includes("recognize-ok"))
    await engine.kill()
    assert.ok(log.includes("terminate-ok"))
  })
  it("lecture partagée : l'abandon (signal) rend immédiatement « TIMEOUT » sans attendre le moteur", async () => {
    const controller = new AbortController()
    const log: string[] = []
    const handle = hangingHandle(log)
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    const r = await readDocument(new Uint8Array(await grey(400, 300)), "png", { engine: async () => handle.engine, signal: controller.signal, timeoutMs: 60_000 })
    assert.deepEqual([r.status, r.reason], ["TECHNICAL_FAILURE", "TIMEOUT"])
    assert.ok(Date.now() - started < 1_000)
    await handle.terminate()
  })
  it("PDF : dimensions d'image lues avant décompression ; trop grande ou inconnue = refus sans extraction ni OCR ; documents RH inchangés sans l'option", async () => {
    const jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#ffffff" } }).jpeg().toBuffer()
    assert.deepEqual(declaredPdfImagePixels(jpegPdf(jpeg, 200, 100)), { max: 20_000, total: 20_000, count: 1 })
    const huge = jpegPdf(jpeg, 20_000, 20_000)
    const indirect = new Uint8Array(Buffer.from(Buffer.from(jpegPdf(jpeg, 200, 100)).toString("latin1").replace("/Width 200", "/Width 9 0 R"), "latin1"))
    assert.equal(declaredPdfImagePixels(indirect), null)
    let engineCalls = 0
    const engine = async () => { engineCalls++; return quickHandle([]).engine }
    for (const bytes of [huge, indirect]) {
      const r = await readDocument(bytes, "pdf", { engine, maxPdfImagePixels: 25_000_000 })
      assert.deepEqual([r.status, r.reason], ["TECHNICAL_FAILURE", "PDF_IMAGE_TOO_LARGE"])
    }
    assert.equal(engineCalls, 0)
    // Sans l'option (chemin des documents RH) : aucun refus de ce type.
    const legacy = await readDocument(huge, "pdf", { engine })
    assert.notEqual(legacy.reason, "PDF_IMAGE_TOO_LARGE")
  })
})

/** Promesse pilotée par le test (jamais résolue tant que le test ne le décide pas). */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const PENDING = Symbol("PENDING")
/** Résultat de `p` s'il arrive avant `ms`, sinon PENDING (témoin de non-réponse). */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))])
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

describe("R2.1 point 3 — arrêt du moteur lui-même borné : 504 en temps fini, arrêt pendant compté, reprise", () => {
  let savedV3: string | undefined
  before(() => { savedV3 = process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true" })
  after(() => { if (savedV3 === undefined) delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED; else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = savedV3 })
  const env = { ...process.env, PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED: "true" }
  const png = { filename: "photo.png", declaredMimeType: "image/png", bytes: PNG_BYTES }
  /** Lecteur qui rend aussitôt « TIMEOUT » sur le signal d'abandon (comme readDocument). */
  const abortable = (onStart?: () => Promise<unknown>): DocumentReader => async (_bytes, _kind, { signal }) => {
    await onStart?.()
    return new Promise<Reading>((resolve) => signal.addEventListener("abort", () => resolve(reading("", { status: "TECHNICAL_FAILURE", reason: "TIMEOUT" }))))
  }
  const deps = (engine: VehicleOcrEngine, read: DocumentReader, over: Record<string, unknown> = {}) =>
    ({ ...new V3MemoryDb().deps(ADMIN), env, engine, read, deadlineMs: 20, graceMs: 20, ...over })
  const call = (d: ReturnType<typeof deps>) => recognizeVehicleDocument(TRUCK, { category: "INSURANCE" }, png, d as never)
  const code = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string; status?: number; message?: string }) => (e.code ? `${e.status} ${e.code}` : `ERR ${e.message}`))

  it("contre-exemple Codex : lecture, chargement et kill jamais résolus → 504 avant le témoin de 200 ms ; travail compté jusqu'à sa vraie fin", async () => {
    const read = deferred<Reading>(), load = deferred<OcrEngine>(), stop = deferred()
    const engine: VehicleOcrEngine = { get: () => load.promise, kill: () => stop.promise, loaded: () => true }
    const started = Date.now()
    const outcome = await within(code(call(deps(engine, () => read.promise))), 200)
    assert.equal(outcome, "504 RECOGNITION_TIMEOUT")
    assert.ok(Date.now() - started < 200)
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 1], "place de lecture rendue, travail non terminé compté")
    read.resolve(reading(""))
    await tick()
    assert.equal(abandonedRecognitions(), 1, "lecture finie mais arrêt du moteur toujours pendant : encore compté")
    stop.resolve()
    await tick()
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 0])
  })

  it("lecteur qui rend aussitôt sur le signal mais kill pendant : arrêt compté ; accumulation bornée à deux travaux puis 429 ; libération à la fin réelle", async () => {
    const stops = [deferred(), deferred()]
    let kills = 0
    const engine: VehicleOcrEngine = { get: async () => quickHandle([]).engine, kill: () => stops[kills++].promise, loaded: () => false }
    assert.equal(await within(code(call(deps(engine, abortable()))), 200), "504 RECOGNITION_TIMEOUT")
    assert.deepEqual([runningRecognitions(), abandonedRecognitions()], [0, 1], "TIMEOUT déjà rendu par le lecteur, arrêt pendant : compté")
    assert.equal(await code(call(deps(engine, async () => reading(INSURANCE)))), "OK", "une place reste pour une lecture")
    assert.equal(await within(code(call(deps(engine, abortable()))), 200), "504 RECOGNITION_TIMEOUT")
    assert.equal(abandonedRecognitions(), 2)
    assert.equal(await code(call(deps(engine, async () => reading(INSURANCE)))), "429 RECOGNITION_BUSY", "pas de troisième moteur tant que deux arrêts sont pendants")
    stops[0].resolve()
    await tick()
    assert.equal(abandonedRecognitions(), 1)
    assert.equal(await code(call(deps(engine, async () => reading(INSURANCE)))), "OK", "reprise dès qu'un arrêt finit réellement")
    stops[1].resolve()
    await tick()
    assert.deepEqual([runningRecognitions(), abandonedRecognitions(), kills], [0, 0, 2])
  })

  it("moteur réel : terminate pendant → 504 borné, moteur oublié, place tenue ; terminate fini → place rendue et reprise avec un moteur neuf", async () => {
    const terminating = deferred()
    const log: string[] = []
    let made = 0
    const engine = createVehicleOcrEngine(async () => (made++ === 0
      ? { engine: { recognize: () => new Promise(() => {}) }, terminate: () => { log.push("terminate-1"); return terminating.promise } }
      : quickHandle(log)))
    const read = abortable(() => engine.get())
    assert.equal(await within(code(call(deps(engine, read))), 200), "504 RECOGNITION_TIMEOUT")
    assert.deepEqual([log, engine.loaded(), abandonedRecognitions()], [["terminate-1"], false, 1])
    terminating.resolve()
    await tick()
    assert.equal(abandonedRecognitions(), 0)
    const again = await recognizePost(request({ category: "INSURANCE" }, { name: "photo.png", type: "image/png", bytes: new Uint8Array(await grey(400, 300)) }), params,
      { ...new V3MemoryDb().deps(ADMIN), env, engine } as never)
    assert.equal(again.status, 200)
    assert.equal(made, 2, "reprise : moteur rechargé")
    await engine.kill()
  })

  it("chargement bloqué : kill pendant mais moteur oublié tout de suite ; chargement tardif aussitôt terminé, sans toucher au moteur plus récent", async () => {
    const slow = deferred<OcrEngineHandle>()
    const log: string[] = []
    let made = 0
    const engine = createVehicleOcrEngine(() => (made++ === 0 ? slow.promise : Promise.resolve(quickHandle(log))))
    void engine.get().catch(() => {})
    await tick()
    const killing = engine.kill()
    assert.equal(engine.loaded(), false)
    assert.equal(await within(killing, 50), PENDING, "arrêt pendant tant que le chargement ne finit pas")
    await engine.get()
    assert.deepEqual([made, engine.loaded()], [2, true])
    slow.resolve({ engine: quickHandle([]).engine, terminate: async () => { log.push("terminate-late") } })
    assert.equal(await within(killing, 200), undefined, "arrêt fini dès que le chargement tardif est terminé")
    assert.deepEqual([log, engine.loaded()], [["terminate-late"], true], "seul l'ancien moteur est terminé")
    await engine.get()
    assert.equal(made, 2, "moteur récent réutilisé")
    await engine.kill()
    assert.deepEqual(log, ["terminate-late", "terminate-ok"])
  })

  it("chargement ancien en échec tardif : n'efface pas le handle du moteur plus récent", async () => {
    const failing = deferred<OcrEngineHandle>()
    let made = 0
    const engine = createVehicleOcrEngine(() => (made++ === 0 ? failing.promise : Promise.resolve(quickHandle([]))))
    const first = engine.get().then(() => "ok", () => "rejected")
    await tick()
    const killing = engine.kill()
    await engine.get()
    failing.reject(new Error("chargement échoué"))
    assert.deepEqual([await first, await within(killing, 200)], ["rejected", undefined])
    assert.equal(engine.loaded(), true)
    await engine.get()
    assert.equal(made, 2)
    await engine.kill()
    assert.equal(engine.loaded(), false)
  })

  it("factory jamais résolue : la route rend 504 en temps fini et 429 tant que deux arrêts restent pendants", async () => {
    const blocked = [deferred<OcrEngineHandle>(), deferred<OcrEngineHandle>()]
    let made = 0
    const engine = createVehicleOcrEngine(() => blocked[made++].promise)
    const read = abortable(() => engine.get())
    for (let i = 0; i < 2; i++) assert.equal(await within(code(call(deps(engine, read))), 200), "504 RECOGNITION_TIMEOUT")
    assert.deepEqual([made, abandonedRecognitions()], [2, 2])
    assert.equal(await code(call(deps(engine, read))), "429 RECOGNITION_BUSY")
    assert.equal(made, 2, "aucun chargement supplémentaire")
    blocked.forEach((b) => b.reject(new Error("chargement abandonné")))
    await tick()
    assert.deepEqual([runningRecognitions(), abandonedRecognitions(), engine.loaded()], [0, 0, false])
  })
})
