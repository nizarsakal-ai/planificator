// Amendement SPEC-INVOICE-IMPORT-001 §5 — tests unitaires (sans base) : totaux des pièces importées, totaux Planificator,
// combinaison par source, réimport après passage en « Payée », empreinte recalculée.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ImportedTotalsError, combineTotals, computeImportedTotals, isImportedOverdue, signedTTCCents, type ImportedTotalsRow } from "@/lib/invoice-import/imported-totals"
import { summarizeNativeInvoices, type NativeSummaryInvoice } from "@/lib/billing/invoices/invoice-queries"
import { analyzeBatch, rowContentHash, type AnalysisState, type ExistingImported } from "@/lib/invoice-import/analyze"
import { hashWithStatus } from "@/lib/invoice-import/status-update.service"
import { numberKey } from "@/lib/invoice-import/normalize"
import type { ImportStatus, PreviewRow } from "@/lib/invoice-import/types"

const B = (n: number | string) => BigInt(n)
const TODAY = new Date("2026-11-19T00:00:00Z")
const inv = (cents: number | string, status: ImportStatus, dueDate: string | null = null): ImportedTotalsRow => ({ kind: "INVOICE", status, totalTTCCents: B(cents), dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null })
const cn = (cents: number | string, status: ImportStatus): ImportedTotalsRow => ({ kind: "CREDIT_NOTE", status, totalTTCCents: B(cents), dueDate: null })

describe("pièces importées — signe et statuts", () => {
  it("le signe vient de la nature : facture +, avoir − (montants stockés positifs)", () => {
    assert.equal(signedTTCCents({ kind: "INVOICE", totalTTCCents: B(1000) }), B(1000))
    assert.equal(signedTTCCents({ kind: "CREDIT_NOTE", totalTTCCents: B(1000) }), B(-1000))
  })
  it("un montant négatif en base est refusé (donnée corrompue, pas de double négation)", () => {
    assert.throws(() => signedTTCCents({ kind: "CREDIT_NOTE", totalTTCCents: B(-1000) }), ImportedTotalsError)
    assert.throws(() => computeImportedTotals([inv(-5, "PAID")], TODAY), ImportedTotalsError)
  })
  it("avoir payé : déduit de l'encaissé, jamais compté comme un encaissement", () => {
    const t = computeImportedTotals([inv(100000, "PAID"), cn(30000, "PAID")], TODAY)
    assert.equal(t.collectedCents, B(70000))
    assert.equal(t.dueCents, B(0))
  })
  it("avoir non soldé : déduit du dû, n'est ni une facture en attente ni en retard", () => {
    const t = computeImportedTotals([inv(100000, "ISSUED", "2026-12-31"), cn(20000, "ISSUED")], TODAY)
    assert.equal(t.dueCents, B(80000))
    assert.equal(t.openCount, 1)
    assert.equal(t.overdueCount, 0)
  })
  it("dû négatif conservé (avoir non soldé sur facture déjà payée) : jamais ramené à zéro en silence", () => {
    const t = computeImportedTotals([inv(100000, "PAID"), cn(20000, "ISSUED")], TODAY)
    assert.equal(t.collectedCents, B(100000))
    assert.equal(t.dueCents, B(-20000))
  })
  it("statuts mixtes : chaque pièce dans un seul total, exclusions comptées par motif", () => {
    const t = computeImportedTotals([
      inv(1000, "PAID"), inv(2000, "ISSUED", "2026-12-01"), inv(4000, "ISSUED", "2026-11-18"), inv(8000, "OVERDUE"),
      inv(16000, "PARTIALLY_PAID"), inv(32000, "CANCELLED"), inv(64000, "UNKNOWN"), cn(500, "CANCELLED"), cn(250, "UNKNOWN"),
    ], TODAY)
    assert.equal(t.collectedCents, B(1000))
    assert.equal(t.dueCents, B(14000))
    assert.equal(t.overdueCents, B(12000))
    assert.equal(t.overdueCount, 2)
    assert.equal(t.openCount, 3)
    assert.equal(t.countedCount, 4)
    assert.deepEqual(t.excluded, { unknown: 2, partial: 1, cancelled: 2 })
  })
  it("annulées exclues de tous les totaux", () => {
    const t = computeImportedTotals([inv(5000, "CANCELLED"), cn(5000, "CANCELLED")], TODAY)
    assert.deepEqual([t.collectedCents, t.dueCents, t.overdueCents, t.countedCount], [B(0), B(0), B(0), 0])
  })
  it("montants à zéro : neutres, pièce comptée sans fausser les totaux", () => {
    const t = computeImportedTotals([inv(0, "PAID"), inv(0, "ISSUED", "2026-01-01"), cn(0, "PAID")], TODAY)
    assert.deepEqual([t.collectedCents, t.dueCents, t.overdueCents], [B(0), B(0), B(0)])
    assert.equal(t.countedCount, 3)
  })
  it("liste vide : tout à zéro", () => {
    const t = computeImportedTotals([], TODAY)
    assert.deepEqual([t.collectedCents, t.dueCents, t.overdueCents, t.openCount, t.overdueCount], [B(0), B(0), B(0), 0, 0])
  })
  it("retard : échéance strictement antérieure au jour, pas le jour même ; jamais pour un avoir", () => {
    assert.equal(isImportedOverdue(inv(1, "ISSUED", "2026-11-19"), TODAY), false)
    assert.equal(isImportedOverdue(inv(1, "ISSUED", "2026-11-18"), TODAY), true)
    assert.equal(isImportedOverdue(inv(1, "ISSUED"), TODAY), false)
    assert.equal(isImportedOverdue(inv(1, "PAID", "2020-01-01"), TODAY), false)
    assert.equal(isImportedOverdue({ kind: "CREDIT_NOTE", status: "OVERDUE", dueDate: null }, TODAY), false)
  })
  it("date du jour invalide refusée", () => {
    assert.throws(() => computeImportedTotals([], new Date("x")), ImportedTotalsError)
  })
})

describe("critère de recette — chiffres de référence (38 pièces : 36 factures, 2 avoirs, toutes « Payée »)", () => {
  // Factures : 463 939,87 € TTC ; avoirs : 2 384,80 € (Agasf) + 13 800,00 € (JAULIN) = 16 184,80 € ; net 447 755,07 €.
  const invoices: ImportedTotalsRow[] = Array.from({ length: 35 }, () => inv(1288722, "PAID"))
  invoices.push(inv(46393987 - 35 * 1288722, "PAID"))
  const rows = [...invoices, cn(238480, "PAID"), cn(1380000, "PAID")]

  it("jeu de test conforme aux chiffres de référence", () => {
    assert.equal(rows.length, 38)
    assert.equal(invoices.reduce((s, r) => s + r.totalTTCCents, B(0)), B(46393987))
  })
  it("Total encaissé = 447 755,07 € ; Total dû = 0,00 € ; En retard = 0,00 €", () => {
    const t = computeImportedTotals(rows, TODAY)
    assert.equal(t.collectedCents, B(44775507))
    assert.equal(t.dueCents, B(0))
    assert.equal(t.overdueCents, B(0))
    assert.deepEqual(t.excluded, { unknown: 0, partial: 0, cancelled: 0 })
  })
  it("avant le passage en « Payée » (toutes UNKNOWN) : rien dans les totaux, 38 exclues signalées", () => {
    const t = computeImportedTotals(rows.map((r) => ({ ...r, status: "UNKNOWN" as const })), TODAY)
    assert.deepEqual([t.collectedCents, t.dueCents], [B(0), B(0)])
    assert.equal(t.excluded.unknown, 38)
  })
  it("si seules les factures passent en « Payée », l'encaissé serait 463 939,87 € (pourquoi les avoirs sont inclus au changement en masse)", () => {
    const t = computeImportedTotals(rows.map((r) => (r.kind === "CREDIT_NOTE" ? { ...r, status: "UNKNOWN" as const } : r)), TODAY)
    assert.equal(t.collectedCents, B(46393987))
  })
  it("combiné avec Planificator (brouillon PROV-2026-0001 de 12 865,92 € exclu) : encaissé 447 755,07 €, dû 0,00 €", () => {
    const native = summarizeNativeInvoices(B(0), [{ status: "DRAFT", kind: "INVOICE", dueDate: null, totalTTCCents: B(1286592), paidCents: B(0), partialCreditCents: B(0) }], TODAY)
    const c = combineTotals(native, computeImportedTotals(rows, TODAY))
    assert.equal(c.total.collectedCents, B(44775507))
    assert.equal(c.total.dueCents, B(0))
    assert.equal(c.planificator.collectedCents, B(0))
    assert.equal(c.imported?.collectedCents, B(44775507))
  })
})

describe("totaux Planificator (fonction pure extraite de invoiceSummary)", () => {
  const n = (p: Partial<NativeSummaryInvoice>): NativeSummaryInvoice => ({ status: "SENT", kind: "INVOICE", dueDate: null, totalTTCCents: B(10000), paidCents: B(0), partialCreditCents: B(0), ...p })
  it("brouillons, payées et annulées exclus du dû ; avoirs exclus", () => {
    const s = summarizeNativeInvoices(B(0), [n({ status: "DRAFT" }), n({ status: "PAID" }), n({ status: "CANCELLED" }), n({ kind: "CREDIT_NOTE" })], TODAY)
    assert.deepEqual([s.dueCents, s.openCount, s.overdueCount], [B(0), 0, 0])
  })
  it("émise et partielle : TTC − paiements − avoirs partiels ; retard sur échéance dépassée", () => {
    const s = summarizeNativeInvoices(B(4000), [n({ paidCents: B(3000), partialCreditCents: B(1000), dueDate: new Date("2026-11-01T00:00:00Z") }), n({ status: "PARTIAL", paidCents: B(1000) })], TODAY)
    assert.equal(s.collectedCents, B(4000))
    assert.equal(s.dueCents, B(15000))
    assert.equal(s.overdueCents, B(6000))
    assert.deepEqual([s.openCount, s.overdueCount], [2, 1])
  })
  it("sans import (drapeau coupé) : totaux strictement identiques à Planificator", () => {
    const native = { collectedCents: B(1), dueCents: B(2), overdueCents: B(3), openCount: 4, overdueCount: 5 }
    const c = combineTotals(native, null)
    assert.deepEqual(c.total, native)
    assert.equal(c.imported, null)
  })
})

describe("réimport après passage en « Payée »", () => {
  const row = (p: Partial<PreviewRow>): PreviewRow => ({
    id: "r1", origin: { type: "table", file: "t.csv", line: 2 }, kind: "INVOICE", number: "2026-06-000025", clientName: "JAULIN", clientId: null, createClient: false, worksiteId: null,
    issueDate: "2026-06-10", dueDate: "2026-07-10", htCents: "1150000", vatCents: "230000", ttcCents: "1380000", sourceStatus: null, status: "UNKNOWN", sourceReference: null, creditedNumber: null,
    fileId: "f1", fileName: "x.pdf", expectedFileName: null, decision: null, excluded: false, extractionNote: null, ...p,
  })
  const state = (existing: ExistingImported): AnalysisState => ({ clients: [{ id: "c1", name: "JAULIN" }], imported: [existing], native: [], worksiteIds: new Set() })
  const existingPaid = (r: PreviewRow): ExistingImported => {
    const paid = { ...r, status: "PAID" as const }
    return {
      id: "imp1", kind: "INVOICE", number: r.number, numberKey: numberKey(r.number), contentHash: rowContentHash(paid, "c1"), fileId: "f1", clientId: "c1", clientName: "JAULIN",
      issueDate: r.issueDate as string, dueDate: r.dueDate, htCents: r.htCents as string, vatCents: r.vatCents as string, ttcCents: r.ttcCents as string, status: "PAID", creditedNumber: null,
    }
  }
  it("statut entrant « non précisé » face à une pièce « Payée » : déjà importée, pas de conflit", () => {
    const r = row({})
    const [a] = analyzeBatch([r], state(existingPaid(r)))
    assert.equal(a.outcome, "SKIP")
    assert.ok(a.anomalies.some((x) => x.code === "ALREADY_IMPORTED"))
    assert.ok(!a.anomalies.some((x) => x.code === "CONFLICT"))
  })
  it("statut entrant explicite et différent (ex. « Émise ») : reste un conflit, l'existant n'est jamais écrasé", () => {
    const r = row({ status: "ISSUED" })
    const [a] = analyzeBatch([r], state(existingPaid(row({}))))
    assert.equal(a.outcome, "BLOCKED")
    assert.deepEqual(a.conflict?.differences.map((d) => d.field), ["Statut"])
  })
  it("facture avec « facture d'origine » dans l'export (non stockée) : reconnue après recalcul de l'empreinte en base", () => {
    const r = row({ creditedNumber: "2026-05-000001" })
    const stored = { kind: "INVOICE" as const, numberKey: numberKey(r.number), clientId: "c1", issueDate: new Date("2026-06-10T00:00:00Z"), dueDate: new Date("2026-07-10T00:00:00Z"), totalHTCents: BigInt(1150000), vatCents: BigInt(230000), totalTTCCents: BigInt(1380000), creditedNumber: null }
    const e = { ...existingPaid(row({})), contentHash: hashWithStatus(stored, "PAID") }
    const [a] = analyzeBatch([r], state(e))
    assert.equal(a.outcome, "SKIP")
    assert.ok(a.anomalies.some((x) => x.code === "ALREADY_IMPORTED"))
  })
  it("empreinte d'origine (avec « facture d'origine ») toujours reconnue : compatibilité ascendante", () => {
    const r = row({ creditedNumber: "2026-05-000001", status: "PAID" })
    const e = { ...existingPaid(row({})), contentHash: rowContentHash(r, "c1") }
    const [a] = analyzeBatch([r], state(e))
    assert.equal(a.outcome, "SKIP")
  })
  it("statut « non précisé » mais montant différent : conflit sur le montant seulement (pas sur le statut)", () => {
    const r = row({ htCents: "1150001", ttcCents: "1380001" })
    const [a] = analyzeBatch([r], state(existingPaid(row({}))))
    assert.ok(a.anomalies.some((x) => x.code === "CONFLICT"))
    assert.deepEqual(a.conflict?.differences.map((d) => d.field), ["Montant HT", "Montant TTC"])
  })
})

describe("lignes agrégées (count)", () => {
  it("une ligne agrégée équivaut à ses pièces : sommes et compteurs", () => {
    const agg = computeImportedTotals([{ ...inv(30000, "ISSUED", "2026-11-01"), count: 3 }, { ...cn(500, "UNKNOWN"), count: 4 }, { ...inv(9000, "PAID"), count: 2 }], TODAY)
    const each = computeImportedTotals([inv(10000, "ISSUED", "2026-11-01"), inv(10000, "ISSUED", "2026-11-01"), inv(10000, "ISSUED", "2026-11-01"), cn(500, "UNKNOWN"), cn(0, "UNKNOWN"), cn(0, "UNKNOWN"), cn(0, "UNKNOWN"), inv(4500, "PAID"), inv(4500, "PAID")], TODAY)
    assert.deepEqual(agg, each)
  })
  it("nombre de pièces invalide refusé", () => {
    assert.throws(() => computeImportedTotals([{ ...inv(1, "PAID"), count: 0 }], TODAY), ImportedTotalsError)
    assert.throws(() => computeImportedTotals([{ ...inv(1, "PAID"), count: 1.5 }], TODAY), ImportedTotalsError)
  })
})

describe("empreinte recalculée au changement de statut", () => {
  it("hashWithStatus (pièce en base) = rowContentHash (ligne d'import) pour le même contenu et le même statut", () => {
    const r: PreviewRow = {
      id: "r", origin: { type: "table", file: "t", line: 1 }, kind: "CREDIT_NOTE", number: "2026-08-000031", clientName: "Agasf", clientId: "c9", createClient: false, worksiteId: null,
      issueDate: "2026-08-02", dueDate: null, htCents: "198733", vatCents: "39747", ttcCents: "238480", sourceStatus: null, status: "PAID", sourceReference: null, creditedNumber: "2026-07-000020",
      fileId: null, fileName: null, expectedFileName: null, decision: null, excluded: false, extractionNote: null,
    }
    const db = {
      kind: "CREDIT_NOTE" as const, numberKey: numberKey(r.number), clientId: "c9", issueDate: new Date("2026-08-02T00:00:00Z"), dueDate: null,
      totalHTCents: B(198733), vatCents: B(39747), totalTTCCents: B(238480), creditedNumber: "2026-07-000020",
    }
    assert.equal(hashWithStatus(db, "PAID"), rowContentHash(r, "c9"))
    assert.notEqual(hashWithStatus(db, "UNKNOWN"), rowContentHash(r, "c9"))
  })
})
