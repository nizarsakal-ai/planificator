/**
 * PLV2-DOC-RH-002 — reconnaissance locale, formats réels, catalogue et fiches à compléter.
 * Données exclusivement synthétiques : spécimens OACI 9303 (UTOPIA, ERIKSSON ANNA MARIA) et personnes fictives.
 */
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { checkDigit, parseMrz, shape } from "../../src/lib/hr-documents/recognition/mrz"
import { fileNameTokens, matchPeople, readLabels, recognize } from "../../src/lib/hr-documents/recognition/engine"
import { externalRecognizer } from "../../src/lib/hr-documents/recognition/external"
import { detectKind, draftSchema, HrError, reviewSchema, validateDocument } from "../../src/lib/hr-documents/domain"
import { availableCategories, isAcceptedCategory } from "../../src/lib/hr-documents/catalog"
import { HrDocumentsService, type Repository, type Tx } from "../../src/lib/hr-documents/service"
import { buildMinimalTextPdf, extractPdfTextLayer } from "../../src/lib/acquisition/extraction/pdf-text-extract"

const FLAGS = ["HR_DOCUMENT_EXTENDED_CATEGORIES_ENABLED", "HR_DOCUMENT_IMAGES_ENABLED", "HR_DOCUMENT_RECOGNITION_ENABLED",
  "HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED", "HR_DOCUMENT_EXTERNAL_RECOGNITION_ENABLED"]
const saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]))
afterEach(() => { for (const f of FLAGS) { if (saved[f] === undefined) delete process.env[f]; else process.env[f] = saved[f] } })
const NOW = new Date("2026-11-03T12:00:00Z")

// Spécimens publiés dans OACI Doc 9303 (État fictif UTO).
const TD3 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10"
const TD1 = "I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<"

describe("MRZ (OACI 9303)", () => {
  it("chiffre de contrôle 7-3-1 conforme aux spécimens", () => {
    assert.equal(checkDigit("L898902C3"), "6")
    assert.equal(checkDigit("740812"), "2")
    assert.equal(checkDigit("120415"), "9")
  })
  it("passeport TD3 : nom, prénoms, naissance, sexe, nationalité, expiration ; numéro réduit à 4 caractères", () => {
    const m = parseMrz(TD3, NOW)!
    assert.equal(m.format, "TD3"); assert.equal(m.checksValid, true)
    assert.equal(m.surname, "ERIKSSON"); assert.equal(m.givenNames, "ANNA MARIA")
    assert.equal(m.birthDate, "1974-08-12"); assert.equal(m.sex, "F"); assert.equal(m.nationality, "UTO"); assert.equal(m.expiryDate, "2012-04-15")
    assert.equal(m.documentNumberEnd, "02C3"); assert.equal(JSON.stringify(m).includes("L898902C3"), false)
  })
  it("carte TD1 (format CNI 2021 / titre de séjour)", () => {
    const m = parseMrz(TD1, NOW)!
    assert.equal(m.format, "TD1"); assert.equal(m.checksValid, true); assert.equal(m.documentCode, "I")
    assert.equal(m.surname, "ERIKSSON"); assert.equal(m.birthDate, "1974-08-12"); assert.equal(m.expiryDate, "2012-04-15")
  })
  it("bande retrouvée même si l'extraction PDF a fusionné les lignes par des espaces", () => {
    const merged = `PASSEPORT ${TD3.replace("\n", " ")} AUTRE TEXTE`
    const m = parseMrz(merged, NOW)!
    assert.equal(m.format, "TD3"); assert.equal(m.checksValid, true); assert.equal(m.surname, "ERIKSSON")
    assert.equal(parseMrz(`CARTE ${TD1.replace(/\n/g, " ")}`, NOW)!.format, "TD1")
  })
  it("un chiffre de contrôle faux n'est jamais présenté comme sûr", () => {
    const m = parseMrz(TD3.replace("7408122F", "7408123F"), NOW)!
    assert.equal(m.checksValid, false)
    const p = recognize({ text: TD3.replace("7408122F", "7408123F"), fileName: "scan.pdf", employees: [], now: NOW })
    assert.ok(p.category!.confidence < 0.7); assert.equal(p.identity!.mrzChecksValid, false)
  })
  it("ancienne CNI française (2 × 36), lignes construites avec l'algorithme OACI", () => {
    const l1 = "IDFRA" + "TESTEUR".padEnd(25, "<") + "075025"
    const number = "190775A12345", birth = "900215"
    let l2 = number + checkDigit(number) + "JEAN<<PAUL".padEnd(14, "<") + birth + checkDigit(birth) + "M"
    l2 += checkDigit(l1 + l2)
    const m = parseMrz(`${l1}\n${l2}`, NOW)!
    assert.equal(m.format, "FR_ID_LEGACY"); assert.equal(m.checksValid, true)
    assert.equal(m.surname, "TESTEUR"); assert.equal(m.givenNames, "JEAN PAUL"); assert.equal(m.birthDate, "1990-02-15"); assert.equal(m.expiryDate, null)
  })
})

const EMPLOYEES = [{ id: "e1", firstName: "Jean", lastName: "Testeur" }, { id: "e2", firstName: "Anna", lastName: "Eriksson" }]
describe("classement et rapprochement", () => {
  it("bulletin de paie reconnu dans un vrai PDF synthétique (couche texte), période extraite", async () => {
    const pdf = buildMinimalTextPdf("BULLETIN DE PAIE\nPeriode du 01/10/2026 au 31/10/2026\nNet a payer 1 000,00")
    const { text } = await extractPdfTextLayer(pdf)
    const p = recognize({ text, fileName: "document.pdf", employees: EMPLOYEES, now: NOW })
    assert.equal(p.category!.value, "PAYSLIP"); assert.equal(p.category!.source, "TEXT"); assert.equal(p.period!.value, "2026-10")
  })
  it("CNI par nom de fichier : type et salarié proposés, confiance faible (à vérifier)", () => {
    const p = recognize({ text: "", fileName: "CNI JEAN TESTEUR.pdf", employees: EMPLOYEES, now: NOW })
    assert.equal(p.category!.value, "ID_CARD"); assert.equal(p.category!.source, "FILENAME"); assert.ok(p.category!.confidence < 0.7)
    assert.equal(p.proposedEmployeeId, "e1"); assert.equal(p.canCreateDraft, false)
  })
  it("passeport MRZ d'un salarié connu : rattaché, période = mois d'expiration", () => {
    const p = recognize({ text: TD3, fileName: "scan.pdf", employees: EMPLOYEES, now: NOW })
    assert.equal(p.category!.value, "PASSPORT"); assert.equal(p.proposedEmployeeId, "e2"); assert.equal(p.period!.value, "2012-04")
  })
  it("homonymes : aucun salarié proposé, choix explicite exigé", () => {
    const twins = [...EMPLOYEES, { id: "e3", firstName: "Jean", lastName: "Testeur" }]
    const p = recognize({ text: "", fileName: "CNI JEAN TESTEUR.pdf", employees: twins, now: NOW })
    assert.equal(p.proposedEmployeeId, null); assert.equal(p.candidates.filter((c) => c.level === "STRONG").length, 2)
  })
  it("nom de famille seul : PARTIAL, jamais proposé", () => {
    assert.deepEqual(matchPeople({ tokens: ["TESTEUR"] }, EMPLOYEES), [{ employeeId: "e1", level: "PARTIAL", draft: false }])
    assert.equal(recognize({ text: "", fileName: "CNI TESTEUR.pdf", employees: EMPLOYEES, now: NOW }).proposedEmployeeId, null)
  })
  it("personne absente : fiche à compléter proposée pour une pièce d'identité, pas pour un bulletin", () => {
    const id = recognize({ text: TD1, fileName: "piece.pdf", employees: [EMPLOYEES[0]], now: NOW })
    assert.equal(id.canCreateDraft, true); assert.equal(id.identity!.firstNames!.value, "Anna Maria")
    assert.equal(recognize({ text: "BULLETIN DE PAIE", fileName: "MARC INCONNU.pdf", employees: EMPLOYEES, now: NOW }).canCreateDraft, false)
  })
  it("photo ou scan sans texte : le nom du fichier ne remplit JAMAIS l'identité ; chaque champ vide porte son motif", () => {
    // Cas de la recette réelle : rien n'a été lu dans la pièce elle-même.
    const reading = { status: "UNREADABLE" as const, reason: null, durationMs: 900, pages: 1, rotation: 0, confidence: 12, mrzFound: false }
    const p = recognize({ text: "", fileName: "CNI LUCAS EXEMPLE.pdf", employees: EMPLOYEES, now: NOW, reading })
    assert.equal(p.textFound, false); assert.equal(p.identity!.lastName, null); assert.equal(p.identity!.firstNames, null)
    assert.equal(p.identity!.missing.lastName, "UNREADABLE"); assert.equal(p.identity!.missing.birthDate, "UNREADABLE")
    assert.equal(p.category!.source, "FILENAME"); assert.equal(p.canCreateDraft, true)
    for (const status of ["ENGINE_MISSING", "TECHNICAL_FAILURE"] as const)
      assert.equal(recognize({ text: "", fileName: "CNI X Y.pdf", employees: [], now: NOW, reading: { ...reading, status } }).identity!.missing.firstNames, status)
    assert.equal(recognize({ text: TD3, fileName: "x.pdf", employees: [], now: NOW }).textFound, true)
  })
  it("salarié existant suggéré par le nom du fichier : marqué comme tel, jamais comme lu", () => {
    const p = recognize({ text: "", fileName: "CNI JEAN TESTEUR.pdf", employees: EMPLOYEES, now: NOW })
    assert.equal(p.proposedEmployeeId, "e1"); assert.equal(p.personSource, "FILENAME"); assert.equal(p.identity!.lastName, null)
  })
  it("document illisible ou inconnu : « à reconnaître », sans erreur", () => {
    const p = recognize({ text: "", fileName: "IMG_2041.pdf", employees: EMPLOYEES, now: NOW })
    assert.equal(p.category, null); assert.equal(p.proposedEmployeeId, null); assert.equal(p.canCreateDraft, false)
  })
  it("avenant reconnu avant contrat ; mots du nom de fichier filtrés", () => {
    assert.equal(recognize({ text: "AVENANT AU CONTRAT DE TRAVAIL", fileName: "x.pdf", employees: [], now: NOW }).category!.value, "AMENDMENT")
    assert.deepEqual(fileNameTokens("Bulletin_de_paie-OCTOBRE 2026 Jean TESTEUR.pdf"), ["JEAN", "TESTEUR"])
  })
})

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16), Buffer.from("IEND", "latin1"), Buffer.alloc(4)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16), Buffer.from([0xff, 0xd9])])
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(16)])
describe("lecture OCR : MRZ abîmée, libellés imprimés, provenance par champ", () => {
  it("MRZ lue par OCR : O/0, I/1, B/8 remis à leur place selon la zone, « < » lus K ou L restaurés", () => {
    const damaged = "P<UTOERIKSSON<<ANNA<MARIA<K<<<<<<<<<<<<LLLLL\nL898902C36UTO74O8122F12O4159ZE184226B<<<<<1O"
    const m = parseMrz(damaged, NOW)!
    assert.equal(m.checksValid, true); assert.equal(m.birthDate, "1974-08-12"); assert.equal(m.givenNames, "ANNA MARIA")
    assert.equal(shape("74O8I2", "dddddd"), "740812"); assert.equal(shape("ER1KSSON", "aaaaaaaa"), "ERIKSSON")
  })
  it("chiffres de contrôle faux : la date n'est pas présentée comme sûre et le numéro n'est pas repris", () => {
    const bad = TD3.replace("7408122F", "7408132F")
    const p = recognize({ text: bad, fileName: "x.pdf", employees: [], now: NOW })
    assert.equal(p.identity!.mrzChecksValid, false); assert.ok(p.identity!.birthDate!.confidence < 0.7)
    const n = recognize({ text: TD3.replace("L898902C36", "L898902C37"), fileName: "x.pdf", employees: [], now: NOW })
    assert.equal(n.identity!.documentNumberEnd, null)
  })
  it("plusieurs lectures d'une même bande : la version aux contrôles justes l'emporte", () => {
    const wrong = TD3.replace("7408122F", "7408132F")
    assert.equal(parseMrz(`${wrong}\n\n${TD3}`, NOW)!.checksValid, true)
  })
  it("une ligne lue deux fois ne sert jamais de ligne des noms", () => {
    const l1 = "I<UTOD231458907<<<<<<<<<<<<<<<", l2 = "7408122F1204159UTO<<<<<<<<<<<6"
    assert.equal(parseMrz(`${l1}\n${l2}\n${l1}`, NOW), null)
  })
  it("noms jamais protégés par un chiffre de contrôle : sûrs seulement si le libellé imprimé concorde", () => {
    const alone = recognize({ text: TD1, fileName: "x.pdf", employees: [], now: NOW }).identity!
    assert.equal(alone.lastName!.source, "MRZ"); assert.ok(alone.lastName!.confidence < 0.7); assert.ok(alone.birthDate!.confidence >= 0.9)
    const both = recognize({ text: `NOM / SURNAME\nERIKSSON\nPRÉNOMS / GIVEN NAMES\nAnna, Maria\n${TD1}`, fileName: "x.pdf", employees: [], now: NOW }).identity!
    assert.equal(both.lastName!.confidence, 0.95); assert.equal(both.firstNames!.value, "Anna Maria")
  })
  it("prénom réduit à une lettre isolée : laissé vide, motif « incertain »", () => {
    const td1 = "I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<ANNA<MARIA<<A<<<<<<<<"
    const id = recognize({ text: td1, fileName: "x.pdf", employees: [], now: NOW }).identity!
    assert.equal(id.firstNames, null); assert.equal(id.missing.firstNames, "UNCERTAIN")
  })
  it("libellés imprimés d'une carte (colonnes) : nom, prénoms, sexe, nationalité, dates", () => {
    const text = ["CARTE NATIONALE D'IDENTITÉ / IDENTITY CARD", "NOM / Surname", "MARTINEZ", "Prénoms / Given names", "Claire, Anne",
      "Sexe / Sex   Nationalité / Nationality   Date de naiss. / Date of birth", "F   FRA   13 07 1990",
      "Date d'expiration / Expiry date", "02 03 2031"].join("\n")
    const l = readLabels(text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[’',]/g, " "))
    assert.deepEqual(l, { lastName: "MARTINEZ", firstNames: "CLAIRE ANNE", birthDate: "1990-07-13", expiryDate: "2031-03-02", sex: "F", nationality: "FRA" })
    const p = recognize({ text, fileName: "IMG_2041.jpg", employees: [], now: NOW })
    assert.equal(p.category!.value, "ID_CARD"); assert.equal(p.identity!.birthDate!.source, "TEXT"); assert.equal(p.canCreateDraft, true)
  })
})

describe("formats réels", () => {
  it("type lu dans les octets ; fichier tronqué, renommé ou texte refusé", () => {
    assert.equal(detectKind(buildMinimalTextPdf("x")), "pdf"); assert.equal(detectKind(PNG), "png"); assert.equal(detectKind(JPEG), "jpeg"); assert.equal(detectKind(HEIC), "heic")
    assert.equal(detectKind(JPEG.subarray(0, JPEG.length - 2)), null)
    assert.equal(detectKind(Buffer.from("%PDF-1.4 sans fin")), null)
    assert.equal(detectKind(Buffer.from("MZ exécutable renommé.jpg")), null)
  })
  it("images refusées tant que HR_DOCUMENT_IMAGES_ENABLED est absent", () => {
    delete process.env.HR_DOCUMENT_IMAGES_ENABLED
    assert.throws(() => validateDocument(PNG), (e: unknown) => e instanceof HrError && e.code === "INVALID_PDF")
    process.env.HR_DOCUMENT_IMAGES_ENABLED = "true"
    assert.equal(validateDocument(PNG).kind, "png")
    assert.throws(() => validateDocument(Buffer.from("texte")), (e: unknown) => e instanceof HrError && e.code === "INVALID_FILE")
  })
})

describe("catalogue et drapeaux", () => {
  it("drapeau absent : seules les 4 catégories historiques existent et sont acceptées", () => {
    delete process.env.HR_DOCUMENT_EXTENDED_CATEGORIES_ENABLED
    assert.deepEqual(availableCategories().map((c) => c.code), ["PAYSLIP", "CONTRACT", "AMENDMENT", "OTHER"])
    const base = { employeeId: "e1", period: "2026-10", title: "t", key: "00000000-0000-4000-8000-000000000000" }
    assert.equal(reviewSchema.safeParse({ ...base, category: "ID_CARD" }).success, false)
    assert.equal(reviewSchema.safeParse({ ...base, category: "PAYSLIP" }).success, true)
    process.env.HR_DOCUMENT_EXTENDED_CATEGORIES_ENABLED = "true"
    assert.equal(reviewSchema.safeParse({ ...base, category: "ID_CARD" }).success, true)
    assert.ok(isAcceptedCategory("RESIDENCE_PERMIT")); assert.equal(isAcceptedCategory("NOPE"), false)
  })
  it("secours externe préparé mais jamais actif, même drapeau activé", () => {
    process.env.HR_DOCUMENT_EXTERNAL_RECOGNITION_ENABLED = "true"
    assert.equal(externalRecognizer(), null)
  })
  it("fiche à compléter : numéro de pièce limité à 4 caractères, champs stricts", () => {
    const base = { firstName: "Jean", lastName: "Testeur", key: "00000000-0000-4000-8000-000000000000" }
    assert.equal(draftSchema.safeParse({ ...base, documentNumberEnd: "L898902C3" }).success, false)
    assert.equal(draftSchema.safeParse({ ...base, documentNumberEnd: "02C3" }).success, true)
    assert.equal(draftSchema.safeParse({ ...base, email: "x@example.test" }).success, false)
  })
})

/** Faux dépôt : un employé par société, capacités configurables, trace des sociétés lues. */
function fakeRepo(capabilities: string[], seen: string[], drafts: Map<string, { id: string; firstName: string; lastName: string }>): Repository {
  const people: Record<string, { id: string; firstName: string; lastName: string }[]> = { "co-a": [{ id: "a1", firstName: "Jean", lastName: "Testeur" }], "co-b": [{ id: "b1", firstName: "Anna", lastName: "Eriksson" }] }
  return { run: async (identity, fn) => fn({
    employees: async (companyId: string) => { seen.push(companyId); return people[companyId] ?? [] },
    draftByKey: async (companyId: string, by: string, key: string) => drafts.get(`${companyId}:${by}:${key}`) ?? null,
    createDraft: async (companyId: string, by: string, input: { key: string; firstName: string; lastName: string }) => {
      const e = { id: `d${drafts.size + 1}`, firstName: input.firstName, lastName: input.lastName, draft: true }; drafts.set(`${companyId}:${by}:${input.key}`, e); return e
    },
  } as unknown as Tx, { ...identity, employeeId: null, capabilities: capabilities as never }) }
}
const noDrive = async () => { throw new Error("aucun appel Drive attendu") }
describe("service : validation humaine, isolation et absence d'écriture", () => {
  it("drapeau absent : reconnaissance indisponible", async () => {
    delete process.env.HR_DOCUMENT_RECOGNITION_ENABLED
    const s = new HrDocumentsService(fakeRepo(["IMPORT", "READ"], [], new Map()), noDrive)
    await assert.rejects(s.recognize({ userId: "u", companyId: "co-a" }, buildMinimalTextPdf("x"), "x.pdf"), /DISABLED/)
  })
  it("opérateur sans IMPORT refusé ; société lue = société de la session uniquement", async () => {
    process.env.HR_DOCUMENT_RECOGNITION_ENABLED = "true"
    const seen: string[] = []
    await assert.rejects(new HrDocumentsService(fakeRepo(["READ"], seen, new Map()), noDrive).recognize({ userId: "u", companyId: "co-a" }, buildMinimalTextPdf("x"), "x.pdf"), /FORBIDDEN/)
    const s = new HrDocumentsService(fakeRepo(["IMPORT", "READ"], seen, new Map()), noDrive, undefined, async () => TD3)
    const p = await s.recognize({ userId: "u", companyId: "co-a" }, buildMinimalTextPdf("x"), "scan.pdf")
    assert.deepEqual(seen, ["co-a"])
    // Anna Eriksson n'existe que dans la société B : jamais proposée à la société A.
    assert.equal(p.proposedEmployeeId, null); assert.equal(p.canCreateDraft, true)
  })
  it("fiche à compléter : drapeau requis, idempotente par clé, jamais d'appel Drive", async () => {
    const drafts = new Map(); const hash = async () => "hash"
    delete process.env.HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED
    const s = new HrDocumentsService(fakeRepo(["IMPORT", "READ"], [], drafts), noDrive, undefined, undefined, null, hash)
    const body = { firstName: "Anna", lastName: "Eriksson", key: "00000000-0000-4000-8000-000000000001" }
    await assert.rejects(s.createDraft({ userId: "u", companyId: "co-a" }, body), /DISABLED/)
    process.env.HR_DOCUMENT_EMPLOYEE_DRAFTS_ENABLED = "true"
    const first = await s.createDraft({ userId: "u", companyId: "co-a" }, body)
    const again = await s.createDraft({ userId: "u", companyId: "co-a" }, body)
    assert.equal(first.id, again.id); assert.equal(drafts.size, 1)
  })
})

describe("garde-fous de source", () => {
  const files = ["src/lib/hr-documents/recognition/engine.ts", "src/lib/hr-documents/recognition/mrz.ts", "src/lib/hr-documents/recognition/external.ts",
    "src/app/api/hr-documents/recognize/route.ts", "src/app/api/hr-documents/employees/route.ts", "src/lib/hr-documents/catalog.ts"]
  it("aucune journalisation dans la reconnaissance et les nouvelles routes", () => {
    for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /console\.|logger\.|captureException/, f)
  })
  it("la reconnaissance n'écrit rien : aucune méthode d'écriture du dépôt n'est appelée", () => {
    const service = readFileSync("src/lib/hr-documents/service.ts", "utf8")
    const body = service.slice(service.indexOf("async recognize("), service.indexOf("async createDraft("))
    assert.doesNotMatch(body, /tx\.(insert|save|event|store|createDraft|recordReceipt|notify)/)
  })
  it("aucune option vide désactivée : une proposition absente ne peut pas présélectionner un autre salarié", () => {
    // Régression trouvée en recette : avec une option vide `disabled`, le navigateur choisissait le premier salarié.
    assert.doesNotMatch(readFileSync("src/components/hr-documents/Documents.tsx", "utf8"), /value="" disabled/)
  })
  it("la migration est additive (nouvelle table seulement)", () => {
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_hr_employee_drafts"))!
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8")
    assert.doesNotMatch(sql, /ALTER TABLE "(employees|users|hr_documents)"|DROP /)
  })
})
