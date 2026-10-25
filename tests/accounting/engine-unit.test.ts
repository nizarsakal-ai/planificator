// COMPTABILITÉ A1 — tests unitaires purs : montants, validateur, forme canonique (vecteur de référence).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { formatCents, parseAmountToCents, roundHalfUp, vatCents, MoneyError } from "@/lib/accounting/engine/money"
import { validateEntry, type ValidationContext } from "@/lib/accounting/engine/validate"
import { canonicalEntry, entryHash, genesisHash, canonicalJson } from "@/lib/accounting/engine/canonical"

describe("Montants en centimes", () => {
  it("analyse stricte", () => {
    assert.equal(parseAmountToCents("1234.5"), BigInt(123450))
    assert.equal(parseAmountToCents("0.01"), BigInt(1))
    assert.equal(parseAmountToCents("10"), BigInt(1000))
    for (const bad of ["-1", "1,5", "1.234", " 1", "1e3", "", "abc", "12345678901234"]) {
      assert.throws(() => parseAmountToCents(bad), MoneyError, bad)
    }
  })
  it("formatage", () => {
    assert.equal(formatCents(BigInt(123450)), "1234.50")
    assert.equal(formatCents(BigInt(-5)), "-0.05")
  })
  it("arrondi demi supérieur symétrique et TVA", () => {
    assert.equal(roundHalfUp(BigInt(5), BigInt(10)), BigInt(1))
    assert.equal(roundHalfUp(BigInt(-5), BigInt(10)), BigInt(-1))
    assert.equal(roundHalfUp(BigInt(4), BigInt(10)), BigInt(0))
    assert.equal(vatCents(BigInt(1005), 2000), BigInt(201)) // 10,05 € × 20 % = 2,01
    assert.equal(vatCents(BigInt(333), 550), BigInt(18))     // 3,33 × 5,5 % = 0,183 → 0,18
    assert.throws(() => vatCents(BigInt(100), 10001), MoneyError)
  })
})

describe("Validateur d'écriture", () => {
  const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
    companyId: "A", entryDate: new Date("2026-03-01"), closingEntry: false,
    journal: { companyId: "A", kind: "SALES" },
    fiscalYear: { companyId: "A", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), status: "OPEN" },
    accounts: new Map([["411", { companyId: "A", active: true }], ["706", { companyId: "A", active: true }], ["old", { companyId: "A", active: false }], ["b", { companyId: "B", active: true }]]),
    ...over,
  })
  const ok = [{ accountId: "411", debitCents: BigInt(1200), creditCents: BigInt(0) }, { accountId: "706", debitCents: BigInt(0), creditCents: BigInt(1200) }]
  it("écriture équilibrée acceptée", () => assert.deepEqual(validateEntry(ok, ctx()), []))
  it("refus : déséquilibre, ligne mixte, ligne nulle, une seule ligne", () => {
    assert.ok(validateEntry([ok[0], { ...ok[1], creditCents: BigInt(1199) }], ctx()).includes("UNBALANCED"))
    assert.ok(validateEntry([{ ...ok[0], creditCents: BigInt(1) }, { ...ok[1], creditCents: BigInt(1201) }], ctx()).includes("LINE_BOTH_SIDES"))
    assert.ok(validateEntry([ok[0], ok[1], { accountId: "706", debitCents: BigInt(0), creditCents: BigInt(0) }], ctx()).includes("LINE_ZERO"))
    assert.ok(validateEntry([ok[0]], ctx()).includes("TOO_FEW_LINES"))
    assert.ok(validateEntry([{ ...ok[0], debitCents: BigInt(-1) }, ok[1]], ctx()).includes("LINE_AMOUNT_INVALID"))
  })
  it("refus : comptes inconnu, inactif, autre société", () => {
    assert.ok(validateEntry([{ ...ok[0], accountId: "x" }, ok[1]], ctx()).includes("ACCOUNT_UNKNOWN"))
    assert.ok(validateEntry([{ ...ok[0], accountId: "old" }, ok[1]], ctx()).includes("ACCOUNT_INACTIVE"))
    assert.ok(validateEntry([{ ...ok[0], accountId: "b" }, ok[1]], ctx()).includes("ACCOUNT_OTHER_COMPANY"))
  })
  it("exercice : date hors exercice, fermé, clôture réservée aux OD de clôture", () => {
    assert.ok(validateEntry(ok, ctx({ entryDate: new Date("2027-01-01") })).includes("DATE_OUTSIDE_YEAR"))
    const closing = { companyId: "A", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"), status: "CLOSING" as const }
    assert.ok(validateEntry(ok, ctx({ fiscalYear: closing })).includes("YEAR_NOT_OPEN"))
    assert.deepEqual(validateEntry(ok, ctx({ fiscalYear: closing, closingEntry: true, journal: { companyId: "A", kind: "MISC" } })), [])
    assert.ok(validateEntry(ok, ctx({ fiscalYear: { ...closing, status: "CLOSED" }, closingEntry: true, journal: { companyId: "A", kind: "MISC" } })).includes("YEAR_NOT_OPEN"))
  })
})

describe("Forme canonique v1 et chaînage", () => {
  const entry = {
    companyId: "co_1", journalId: "jr_VT", fiscalYearId: "fy_2026", number: 1,
    entryDate: new Date("2026-03-01T00:00:00Z"), documentDate: null, documentRef: "FAC-2026-0001", label: "Vente Café",
    validatedAt: new Date("2026-03-01T10:20:30.456Z"), validatedById: "usr_1", sourceType: null, sourceId: null,
    sourceVersion: null, reversalOfId: null, closingEntry: false,
    lines: [
      { position: 1, accountId: "acc_706", label: null, debitCents: BigInt(0), creditCents: BigInt(1000), vatRateBp: null },
      { position: 0, accountId: "acc_411", label: null, debitCents: BigInt(1000), creditCents: BigInt(0), vatRateBp: 2000 },
    ],
  }
  it("clés triées, lignes triées par position, montants en chaînes, NFC", () => {
    const c = canonicalEntry(entry, genesisHash("co_1", "jr_VT"))
    assert.ok(c.startsWith('{"closingEntry":false,"companyId":"co_1"'))
    assert.ok(c.indexOf('"acc_411"') < c.indexOf('"acc_706"'))
    assert.ok(c.includes('"debitCents":"1000"'))
    assert.ok(c.includes('"validatedAt":"2026-03-01T10:20:30Z"'))
    assert.equal(canonicalJson({ b: "é", a: 1 }), '{"a":1,"b":"é"}')
  })
  it("vecteur de référence figé (toute modification du format doit changer de version)", () => {
    assert.equal(genesisHash("co_1", "jr_VT"), "4a758e6b4e2fec5df9c4919a0c9cf6dc5b38bf582cb1532c267e3ad4cf7f6f52")
    assert.equal(entryHash(entry, genesisHash("co_1", "jr_VT")), "3c2b9c473ec4b7f6e8847bd63dfaaeac75e133d1a5634376492dfae9e1d1975c")
  })
})

describe("flushDeferredConstraints (garde d'identifiant)", () => {
  it("refuse un identifiant non sûr et n'exécute rien", async () => {
    const { flushDeferredConstraints } = await import("@/lib/deferred-constraints")
    const sql: string[] = []
    const tx = { $executeRawUnsafe: async (q: string) => { sql.push(q); return 0 } } as unknown as Parameters<typeof flushDeferredConstraints>[0]
    await assert.rejects(flushDeferredConstraints(tx, ['x"; DROP TABLE t; --']), /identifiant de contrainte invalide/)
    assert.deepEqual(sql, [])
    await flushDeferredConstraints(tx, ["a_trg", "b_trg"])
    assert.deepEqual(sql, [`SET CONSTRAINTS "a_trg", "b_trg" IMMEDIATE`, `SET CONSTRAINTS "a_trg", "b_trg" DEFERRED`])
    await flushDeferredConstraints(tx, [])
    await flushDeferredConstraints(tx)
    assert.equal(sql.at(-1), "SET CONSTRAINTS ALL IMMEDIATE")
    assert.equal(sql.length, 3)
  })
})

describe("runAccountingTransaction / erreurs transitoires", () => {
  it("rejoue uniquement 40P01/40001/P2034, jamais une erreur métier ; borne le nombre d'essais", async () => {
    const { isTransientConcurrencyError, runAccountingTransaction } = await import("@/lib/accounting/engine/transaction")
    const { AccountingError } = await import("@/lib/accounting/engine/posting")
    assert.equal(isTransientConcurrencyError(new Error("ERROR: deadlock detected (40P01)")), true)
    assert.equal(isTransientConcurrencyError({ code: "P2034", message: "Transaction failed due to a write conflict or a deadlock" }), true)
    assert.equal(isTransientConcurrencyError(new AccountingError("SOURCE_CONFLICT")), false)
    assert.equal(isTransientConcurrencyError(new Error("ENTRY_UNBALANCED")), false)
    let calls = 0
    const fake = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => { calls++; if (calls < 3) throw new Error("deadlock detected"); return fn({}) } }
    const r = await runAccountingTransaction(fake as never, async () => "ok")
    assert.equal(r, "ok")
    assert.equal(calls, 3)
    calls = 0
    const always = { $transaction: async () => { calls++; throw new Error("deadlock detected") } }
    await assert.rejects(runAccountingTransaction(always as never, async () => "x", { maxAttempts: 2 }), /deadlock/)
    assert.equal(calls, 2)
    calls = 0
    const business = { $transaction: async () => { calls++; throw new AccountingError("SOURCE_CONFLICT") } }
    await assert.rejects(runAccountingTransaction(business as never, async () => "x"), (e: unknown) => e instanceof AccountingError)
    assert.equal(calls, 1)
  })
})
