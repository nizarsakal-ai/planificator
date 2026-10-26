// Facturation — Lot B minimal (ADR-PLAN-003) : automate irréversible, avoirs, conditions de concurrence.
// Transaction simulée en mémoire qui applique les filtres `where` comme PostgreSQL (aucune base réelle).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import type { Prisma } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import {
  INVOICE_TRANSITIONS,
  LIFECYCLE_ERRORS,
  canTransition,
  createCreditNoteCore,
  parseRequestedStatus,
  replaceDraftLinesCore,
  transitionInvoiceCore,
} from "@/lib/billing/invoice-lifecycle.core"

// Correctif P2-03 : le figement documentaire réel exige une base ; ces tests de cœur injectent un no-op.
const noSnapshot = async () => {}

type Row = Record<string, unknown> & { id: string }
const A = "company-a"
const B = "company-b"

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([k, v]) => row[k] === v)
}

function makeTx(seed: Row[], lines: Row[] = []) {
  const invoices = seed.map((r) => ({ ...r }))
  const invoiceLines = lines.map((r) => ({ ...r }))
  const history: Row[] = []
  let seq = 0
  const hooks: { beforeUpdate?: () => void } = {}
  const tx = {
    // Correctif R2 : le cœur verrouille le parent (SELECT … FOR UPDATE) avant la lecture ; sans base, le verrou est un no-op.
    $queryRaw: async () => [],
    invoiceDepositDeduction: { count: async () => 0 }, // S1 (même famille) : aucune déduction dans ces scénarios Lot B
    invoice: {
      count: async () => 0,
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const row = invoices.find((r) => matches(r, where))
        if (!row) return null
        const out: Record<string, unknown> = { ...row }
        if (select && "lines" in select) {
          out.lines = invoiceLines.filter((l) => l.invoiceId === row.id).sort((a, b) => Number(a.position) - Number(b.position))
            .map(({ articleId, designation, unit, quantity, unitPrice, vatRate, lineHT, position }) => ({ articleId, designation, unit, quantity, unitPrice, vatRate, lineHT, position }))
        }
        return out
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        hooks.beforeUpdate?.()
        let count = 0
        for (const r of invoices) if (matches(r, where)) { Object.assign(r, data); count++ }
        return { count }
      },
      create: async ({ data }: { data: Record<string, unknown> & { lines?: { create: Row[] } } }) => {
        const id = `new-${++seq}`
        const { lines: nested, ...rest } = data
        invoices.push({ id, ...rest })
        for (const l of nested?.create ?? []) invoiceLines.push({ ...l, id: `l-${++seq}`, invoiceId: id })
        return { id, number: rest.number as string }
      },
    },
    invoiceLine: {
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = invoiceLines.length
        for (let i = invoiceLines.length - 1; i >= 0; i--) if (matches(invoiceLines[i], where)) invoiceLines.splice(i, 1)
        return { count: before - invoiceLines.length }
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const l of data) invoiceLines.push({ ...l, id: `l-${++seq}` })
        return { count: data.length }
      },
    },
    historyLog: { create: async ({ data }: { data: Row }) => { history.push(data); return data } },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, invoices, invoiceLines, history, hooks }
}

const inv = (id: string, status: string, companyId = A, extra: Record<string, unknown> = {}): Row => ({
  id, status, companyId, kind: "INVOICE", number: `FAC-2026-${id}`, worksiteId: "w1", clientId: "c1", quoteId: null,
  periodStart: null, periodEnd: null, totalHT: 100, totalVAT: 20, totalTTC: 120, paymentTerms: null, creditedInvoiceId: null, ...extra,
})
const now = new Date("2026-10-25T12:00:00Z")
setBillingClockForTests(() => now) // R3/S3 : horloge de décision déterministe (= now) pour les horodatages et dates d'émission
const line = (invoiceId: string, position: number): Row => ({
  id: `x-${invoiceId}-${position}`, invoiceId, articleId: null, designation: `L${position}`, unit: "u", quantity: 1, unitPrice: 50, vatRate: 20, lineHT: 50, position,
})

describe("Automate de statuts", () => {
  it("aucun retour à DRAFT, transitions limitées", () => {
    for (const from of Object.keys(INVOICE_TRANSITIONS) as (keyof typeof INVOICE_TRANSITIONS)[]) {
      assert.equal(canTransition(from, "DRAFT"), false)
    }
    assert.equal(canTransition("DRAFT", "SENT"), true)
    assert.equal(canTransition("SENT", "PAID"), true)
    assert.equal(canTransition("PAID", "SENT"), false)
    assert.equal(canTransition("SENT", "CANCELLED"), false)
    assert.equal(canTransition("CANCELLED", "SENT"), false)
  })

  it("validation d'exécution du statut demandé", () => {
    assert.equal(parseRequestedStatus("DRAFT"), null)
    assert.equal(parseRequestedStatus({ toString: () => "SENT" }), null)
    assert.equal(parseRequestedStatus("sent"), null)
    assert.equal(parseRequestedStatus("PAID"), "PAID")
  })

  it("émission DRAFT → SENT : sentAt posé, trace d'audit", async () => {
    const s = makeTx([inv("1", "DRAFT")])
    const r = await transitionInvoiceCore(s.tx, { companyId: A, invoiceId: "1", to: "SENT", actorId: "u", now, captureSnapshot: noSnapshot })
    assert.deepEqual(r, { ok: true, value: undefined })
    assert.equal(s.invoices[0].status, "SENT")
    assert.equal((s.invoices[0].sentAt as Date).toISOString(), now.toISOString()) // S3 : instant de décision (nouvel objet Date, même valeur)
    assert.equal(s.history.length, 1)
    assert.equal(s.history[0].action, "STATUS_CHANGED")
  })

  it("une facture émise ne s'annule pas directement", async () => {
    for (const st of ["SENT", "PAID"]) {
      const s = makeTx([inv("1", st)])
      const r = await transitionInvoiceCore(s.tx, { companyId: A, invoiceId: "1", to: "CANCELLED", actorId: "u", now })
      assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.cancelIssued })
      assert.equal(s.invoices[0].status, st)
      assert.equal(s.history.length, 0)
    }
  })

  it("PAID → SENT refusé ; sentAt jamais réécrit", async () => {
    const s = makeTx([inv("1", "PAID", A, { sentAt: "orig" })])
    const r = await transitionInvoiceCore(s.tx, { companyId: A, invoiceId: "1", to: "SENT", actorId: "u", now, captureSnapshot: noSnapshot })
    assert.equal(r.ok, false)
    assert.equal(s.invoices[0].sentAt, "orig")
  })

  it("isolation : facture d'une autre société introuvable", async () => {
    const s = makeTx([inv("1", "DRAFT", B)])
    const r = await transitionInvoiceCore(s.tx, { companyId: A, invoiceId: "1", to: "SENT", actorId: "u", now, captureSnapshot: noSnapshot })
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.notFound })
    assert.equal(s.invoices[0].status, "DRAFT")
  })

  it("concurrence : statut changé entre la lecture et l'écriture → conflit, rien n'est écrasé", async () => {
    const s = makeTx([inv("1", "SENT")])
    s.hooks.beforeUpdate = () => { s.invoices[0].status = "PAID"; s.hooks.beforeUpdate = undefined }
    const r = await transitionInvoiceCore(s.tx, { companyId: A, invoiceId: "1", to: "PAID", actorId: "u", now })
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.conflict })
    assert.equal(s.history.length, 0)
  })

  it("un avoir n'a aucune transition", async () => {
    const s = makeTx([inv("1", "SENT", A, { kind: "CREDIT_NOTE" })])
    const r = await transitionInvoiceCore(s.tx, { companyId: A, invoiceId: "1", to: "PAID", actorId: "u", now })
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.creditNoteImmutable })
  })
})

describe("Lignes de brouillon", () => {
  const totals = { totalHT: 10, totalVAT: 2, totalTTC: 12 }
  const newLine = { articleId: null, designation: "N", unit: "u", quantity: 1, unitPrice: 10, vatRate: 20, lineHT: 10, position: 0 }

  it("brouillon : lignes remplacées et totaux mis à jour", async () => {
    const s = makeTx([inv("1", "DRAFT")], [line("1", 0), line("1", 1)])
    const r = await replaceDraftLinesCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", lines: [newLine], totals })
    assert.equal(r.ok, true)
    assert.equal(s.invoiceLines.length, 1)
    assert.equal(s.invoices[0].totalTTC, 12)
    assert.equal(s.history.length, 1)
    assert.equal(s.history[0].action, "UPDATED")
  })

  it("facture émise : refus, lignes et totaux intacts", async () => {
    for (const st of ["SENT", "PAID", "CANCELLED"]) {
      const s = makeTx([inv("1", st)], [line("1", 0)])
      const r = await replaceDraftLinesCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", lines: [newLine], totals })
      assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.notDraft })
      assert.equal(s.invoiceLines.length, 1)
      assert.equal(s.invoices[0].totalTTC, 120)
    }
  })

  it("émission concurrente juste avant : la modification échoue au lieu de réécrire la facture émise", async () => {
    const s = makeTx([inv("1", "DRAFT")], [line("1", 0)])
    s.hooks.beforeUpdate = () => { s.invoices[0].status = "SENT"; s.hooks.beforeUpdate = undefined }
    const r = await replaceDraftLinesCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", lines: [newLine], totals })
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.notDraft })
    assert.equal(s.invoiceLines[0].designation, "L0")
  })

  it("autre société : introuvable", async () => {
    const s = makeTx([inv("1", "DRAFT", B)])
    const r = await replaceDraftLinesCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", lines: [newLine], totals })
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.notFound })
  })
})

describe("Avoirs", () => {
  const nextNumber = async () => "AV-2026-0001"

  it("avoir total : copie exacte, émis, facture d'origine annulée, deux traces", async () => {
    const s = makeTx([inv("1", "SENT")], [line("1", 0), line("1", 1)])
    const r = await createCreditNoteCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", reason: "erreur", now, nextNumber, captureSnapshot: noSnapshot })
    assert.equal(r.ok, true)
    const note = s.invoices.find((x) => x.kind === "CREDIT_NOTE")!
    assert.equal(note.status, "SENT")
    assert.equal((note.sentAt as Date).toISOString(), now.toISOString())
    assert.equal(note.creditedInvoiceId, "1")
    assert.equal(note.number, "AV-2026-0001")
    assert.equal(note.totalTTC, 120)
    assert.equal(s.invoiceLines.filter((l) => l.invoiceId === note.id).length, 2)
    assert.equal(s.invoices[0].status, "CANCELLED")
    assert.equal(s.history.length, 2)
  })

  it("avoir sur facture payée accepté", async () => {
    const s = makeTx([inv("1", "PAID")], [line("1", 0)])
    const r = await createCreditNoteCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", reason: null, now, nextNumber, captureSnapshot: noSnapshot })
    assert.equal(r.ok, true)
  })

  it("refusé sur brouillon, facture annulée, avoir, autre société", async () => {
    for (const row of [inv("1", "DRAFT"), inv("1", "CANCELLED"), inv("1", "SENT", A, { kind: "CREDIT_NOTE" }), inv("1", "SENT", B)]) {
      const s = makeTx([row])
      const r = await createCreditNoteCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", reason: null, now, nextNumber, captureSnapshot: noSnapshot })
      assert.equal(r.ok, false)
      assert.equal(s.invoices.length, 1)
    }
  })

  it("un seul avoir par facture", async () => {
    const s = makeTx([inv("1", "SENT"), inv("2", "SENT", A, { kind: "CREDIT_NOTE", creditedInvoiceId: "1" })])
    const r = await createCreditNoteCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", reason: null, now, nextNumber, captureSnapshot: noSnapshot })
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.alreadyCredited })
  })

  it("concurrence : facture changée avant l'annulation → conflit, aucun avoir créé", async () => {
    const s = makeTx([inv("1", "SENT")], [line("1", 0)])
    s.hooks.beforeUpdate = () => { s.invoices[0].status = "PAID"; s.hooks.beforeUpdate = undefined }
    const r = await createCreditNoteCore(s.tx, { companyId: A, invoiceId: "1", actorId: "u", reason: null, now, nextNumber, captureSnapshot: noSnapshot })
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.conflict })
    assert.equal(s.invoices.length, 1)
  })
})

describe("Garanties en base et suppressions (contrôle des sources)", () => {
  const migration = readFileSync("prisma/migrations/20261025180000_billing_lot_b_minimal/migration.sql", "utf8")
  const schema = readFileSync("prisma/schema.prisma", "utf8")
  const chantier = readFileSync("src/lib/actions/chantier.actions.ts", "utf8")
  const superAdmin = readFileSync("src/lib/actions/super-admin.actions.ts", "utf8")

  it("migration : déclencheurs d'immutabilité des factures et lignes", () => {
    assert.match(migration, /CREATE TRIGGER invoices_guard_issued_trg\s+BEFORE INSERT OR UPDATE OR DELETE ON "invoices"/)
    assert.match(migration, /CREATE CONSTRAINT TRIGGER invoices_credit_invariant_trg\s+AFTER INSERT OR UPDATE ON "invoices"\s+DEFERRABLE INITIALLY DEFERRED/)
    assert.match(migration, /FOR SHARE/)
    assert.match(migration, /CREATE TRIGGER invoice_lines_guard_issued_trg\s+BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"/)
    assert.match(migration, /ON DELETE RESTRICT/)
  })

  it("schéma : plus aucune cascade de suppression vers les factures", () => {
    const block = schema.slice(schema.indexOf("model Invoice {"), schema.indexOf("model InvoiceLine {"))
    assert.doesNotMatch(block, /onDelete: Cascade/)
    assert.match(block, /kind\s+InvoiceKind\s+@default\(INVOICE\)/)
  })

  it("suppression d'un chantier ou d'une société facturés refusée côté application", () => {
    assert.match(chantier, /prisma\.invoice\.count\(\{ where: \{ worksiteId, companyId: user\.companyId! \} \}\)/)
    assert.match(superAdmin, /prisma\.invoice\.count\(\{ where: \{ companyId \} \}\)/)
  })
})
