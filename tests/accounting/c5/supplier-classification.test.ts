import { test } from "node:test"
import assert from "node:assert/strict"
import { classificationAfterOcr, normalizeSupplierCategory, suggestedExpenseAccountId, CATEGORY_ACCOUNT } from "@/lib/accounting/c5/supplier-classification"
import { parseOcrPayload } from "@/lib/accounting/c5/ocr-provider"

test("normalise les libellés OCR avec accents, espaces et variantes", () => {
  assert.equal(normalizeSupplierCategory("  Déplacements  "), "deplacement")
  assert.equal(normalizeSupplierCategory("Prestations de services"), "services")
  assert.equal(normalizeSupplierCategory("Entretien et réparations"), "entretien")
  assert.equal(normalizeSupplierCategory("instructions malveillantes"), null)
})
test("facture photo fictive : catégorie reçue puis compte de la société", () => {
  const extraction = parseOcrPayload(JSON.stringify({ supplier: "Location Fictive", invoiceNumber: "TEST-LOCATION-001", amountHT: 100, vatAmount: 20, amountTTC: 120, supplierType: "Locations", confidence: { category: .94 } }))
  assert.equal(extraction.category, "location")
  assert.equal(extraction.totalTTCCents, BigInt(12000))
  assert.equal(suggestedExpenseAccountId(extraction.category, [{ id: "company-rental", number: "613000" }]), "company-rental")
})
test("tolère category si supplierType manque ou est inconnu", () => {
  assert.equal(parseOcrPayload('{"category":"Honoraires"}').category, "honoraires")
  assert.equal(parseOcrPayload('{"supplierType":"inconnu","category":"prestations"}').category, "services")
  assert.equal(parseOcrPayload('{"supplierType":null}').category, null)
})
test("chaque catégorie résout le compte attendu, jamais un identifiant extérieur au plan fourni", () => {
  for (const [category, number] of Object.entries(CATEGORY_ACCOUNT)) {
    assert.equal(suggestedExpenseAccountId(category, [{ id: "tenant-account", number }]), "tenant-account")
    assert.equal(suggestedExpenseAccountId(category, []), "")
  }
  assert.equal(suggestedExpenseAccountId(null, [{ id: "x", number: "606000" }]), "")
})

test("photo lisible sans catégorie : suggestion provisoire explicite et compte de la société", () => {
  assert.deepEqual(classificationAfterOcr({ supplier: "Fictif", totalHTCents: "10000", category: null }, [{ id: "supplies", number: "606000" }]), { category: "autre", expenseAccountId: "supplies", needsReview: true })
  assert.deepEqual(classificationAfterOcr({}, [{ id: "supplies", number: "606000" }]), { category: "", expenseAccountId: "", needsReview: false })
})
test("vocabulaire d'une photo courante et absence de compte dans la société", () => {
  assert.equal(normalizeSupplierCategory("Fournitures de bureau"), "autre")
  assert.equal(normalizeSupplierCategory("Hébergement"), "deplacement")
  assert.equal(normalizeSupplierCategory("Prestation de service"), "services")
  assert.deepEqual(classificationAfterOcr({ category: "location" }, []), { category: "location", expenseAccountId: "", needsReview: false })
})

test("libellés ambigus ne valent pas une imputation comptable reconnue", () => {
  for (const category of ["transport", "restauration", "carburant"]) {
    assert.equal(normalizeSupplierCategory(category), null)
    assert.deepEqual(classificationAfterOcr({ category, supplier: "Fournisseur fictif" }, [{ id: "provisional", number: "606000" }]), { category: "autre", expenseAccountId: "provisional", needsReview: true })
  }
})
test("extraction vide : ni catégorie proposée ni avertissement de proposition provisoire", () => {
  assert.deepEqual(classificationAfterOcr({ supplier: "", invoiceNumber: "", category: null }, []), { category: "", expenseAccountId: "", needsReview: false })
})
test("alias non ambigu : Honoraires résout le compte 622000 de la société", () => {
  assert.deepEqual(classificationAfterOcr({ category: "honoraire" }, [{ id: "fees", number: "622000" }]), { category: "honoraires", expenseAccountId: "fees", needsReview: false })
})
