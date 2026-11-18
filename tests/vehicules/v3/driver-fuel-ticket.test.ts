import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  derivedKey, driverTicketSchema, findBankExpenseToComplete, receiptDocumentBody, ticketCorrectCommand, ticketCreateCommand, ticketDayAllowed, toCents, type CandidateExpense,
} from "@/lib/vehicules/v3/driver-fuel-ticket-domain"
import { authorizeDriverReceipt, driverSessionFrom } from "@/lib/vehicules/v3/driver-receipt-authority"
import { parseExpenseCommand } from "@/lib/vehicules/v3/expense-domain"
import { parseDocumentUpload } from "@/lib/vehicules/v3/document-domain"
import { withFuelTicketNavItem, getNavItems } from "@/lib/navigation/nav-config"

const input = { truckId: "t1", amount: "95,50", litres: "52,3", day: "2026-11-05", station: "TOTAL CARCASSONNE" }
const bank = (over: Partial<CandidateExpense> = {}): CandidateExpense => ({
  id: "e1", revision: 2, day: "2026-11-05", amountCents: 9550, currency: "EUR", reference: "BANQUE:tx1", supplier: "CARTE X1111 TOTAL",
  notes: "Relevé bancaire, carte •1111. Ajoutez le ticket pour les litres.", litres: null, mileageObservation: null, documentVersionId: null, status: "PENDING", ...over,
})

describe("saisie du chauffeur", () => {
  it("montant et litres à la française, champs inconnus refusés", () => {
    assert.equal(driverTicketSchema.safeParse(input).success, true)
    assert.equal(toCents("95,50"), 9550)
    assert.equal(driverTicketSchema.safeParse({ ...input, amount: "-3" }).success, false)
    assert.equal(driverTicketSchema.safeParse({ ...input, category: "OTHER" }).success, false)
  })
  it("date ni future ni de plus de 2 mois", () => {
    assert.equal(ticketDayAllowed("2026-11-05", "2026-11-17"), true)
    assert.equal(ticketDayAllowed("2026-11-18", "2026-11-17"), false)
    assert.equal(ticketDayAllowed("2026-08-01", "2026-11-17"), false)
  })
})

describe("plein du relevé bancaire à compléter", () => {
  it("même montant, ± 1 jour, sans justificatif, référence bancaire", () => {
    assert.equal(findBankExpenseToComplete([bank({ day: "2026-11-06" })], 9550, "2026-11-05")?.id, "e1")
    assert.equal(findBankExpenseToComplete([bank({ day: "2026-11-08" })], 9550, "2026-11-05"), null)
    assert.equal(findBankExpenseToComplete([bank({ amountCents: 9551 })], 9550, "2026-11-05"), null)
    assert.equal(findBankExpenseToComplete([bank({ documentVersionId: "v0" })], 9550, "2026-11-05"), null)
    assert.equal(findBankExpenseToComplete([bank({ reference: "FACT-1" })], 9550, "2026-11-05"), null)
    assert.equal(findBankExpenseToComplete([bank({ status: "REJECTED" })], 9550, "2026-11-05"), null)
  })
  it("deux candidats : aucun choix arbitraire", () => {
    assert.equal(findBankExpenseToComplete([bank(), bank({ id: "e2" })], 9550, "2026-11-05"), null)
  })
})

describe("commandes de dépense", () => {
  const key = derivedKey("11111111-2222-4333-8444-555555555555", "driver-ticket-expense")
  it("clé dérivée stable, au format UUID, différente selon l'usage", () => {
    assert.equal(key, derivedKey("11111111-2222-4333-8444-555555555555", "driver-ticket-expense"))
    assert.notEqual(key, derivedKey("11111111-2222-4333-8444-555555555555", "driver-ticket-document"))
  })
  it("création : plein avec litres et justificatif, valide pour le registre", () => {
    const cmd = ticketCreateCommand(input, "v1", "Hassen")
    const parsed = parseExpenseCommand(cmd, key)
    assert.equal(parsed.command.action, "CREATE")
    assert.deepEqual([cmd.data.category, cmd.data.amount, cmd.data.litres, cmd.data.documentVersionId], ["FUEL", "95.50", "52.3", "v1"])
  })
  it("complément : la référence bancaire, le libellé et le montant sont conservés", () => {
    const cmd = ticketCorrectCommand(bank(), input, "v1", "Hassen")
    assert.equal(parseExpenseCommand(cmd, key).command.action, "CORRECT")
    assert.deepEqual([cmd.expenseId, cmd.expectedRevision, cmd.data.reference, cmd.data.supplier, cmd.data.amount, cmd.data.litres, cmd.data.documentVersionId],
      ["e1", 2, "BANQUE:tx1", "CARTE X1111 TOTAL", "95.50", "52.3", "v1"])
    assert.match(cmd.data.notes, /carte •1111/)
    assert.doesNotMatch(cmd.data.notes, /Ajoutez le ticket/)
  })
  it("justificatif : document EXPENSE_RECEIPT valide", () => {
    const body = receiptDocumentBody(input, "Hassen")
    const parsed = parseDocumentUpload(body, "11111111-2222-4333-8444-555555555555")
    assert.equal(parsed.category, "EXPENSE_RECEIPT")
    assert.equal(parsed.issuedOn, "2026-11-05")
    assert.equal(parsed.issuerName, "TOTAL CARCASSONNE")
  })
})

describe("autorité chauffeur", () => {
  it("session : rôles internes seulement", () => {
    assert.deepEqual(driverSessionFrom({ user: { id: "u", role: "EMPLOYEE", companyId: "c" } }), { userId: "u", companyId: "c", role: "EMPLOYEE" })
    assert.throws(() => driverSessionFrom({ user: { id: "u", role: "CLIENT", companyId: "c" } }))
    assert.throws(() => driverSessionFrom(null))
  })

  // Transaction simulée : chaque $queryRaw renvoie la ligne attendue selon la table interrogée.
  function fakeTx(o: { truck?: { chauffeurId: string | null; active?: boolean } | null; user?: { active: boolean; role: string }; employee?: { id: string; active: boolean; role: string } | null; company?: boolean }) {
    const rows = (sql: string) => {
      if (sql.includes('FROM "trucks"')) return o.truck ? [{ id: "t1" }] : []
      if (sql.includes('FROM "users"')) return [{ id: "u", name: "Hassen", companyId: "c", ...(o.user ?? { active: true, role: "EMPLOYEE" }) }]
      if (sql.includes('FROM "companies"')) return [{ active: o.company ?? true }]
      if (sql.includes('FROM "employees"')) return o.employee === null ? [] : [{ userId: "u", companyId: "c", ...(o.employee ?? { id: "emp1", active: true, role: "EMPLOYEE" }) }]
      return []
    }
    return {
      $queryRaw: async (strings: TemplateStringsArray) => rows(strings.join("?")),
      truck: { findFirst: async () => (o.truck ? { id: "t1", companyId: "c", active: o.truck.active ?? true, chauffeurId: o.truck.chauffeurId } : null) },
    } as never
  }
  const session = { userId: "u", companyId: "c", role: "EMPLOYEE" }
  it("chauffeur attitré : autorisé, justificatifs de dépense seulement", async () => {
    const r = await authorizeDriverReceipt(fakeTx({ truck: { chauffeurId: "emp1" } }), "t1", session)
    assert.deepEqual(r.categories, ["EXPENSE_RECEIPT"])
    assert.equal(r.actor.id, "u")
  })
  it("autre chauffeur, profil inactif, rôle changé ou camion d'une autre société : refusé", async () => {
    await assert.rejects(authorizeDriverReceipt(fakeTx({ truck: { chauffeurId: "emp2" } }), "t1", session), /TRUCK_NOT_FOUND/)
    await assert.rejects(authorizeDriverReceipt(fakeTx({ truck: { chauffeurId: "emp1" }, employee: { id: "emp1", active: false, role: "EMPLOYEE" } }), "t1", session))
    await assert.rejects(authorizeDriverReceipt(fakeTx({ truck: { chauffeurId: "emp1" }, employee: { id: "emp1", active: true, role: "TEAM_LEADER" } }), "t1", session))
    await assert.rejects(authorizeDriverReceipt(fakeTx({ truck: null }), "t1", session), /TRUCK_NOT_FOUND/)
    await assert.rejects(authorizeDriverReceipt(fakeTx({ truck: { chauffeurId: "emp1" }, employee: null }), "t1", session))
    await assert.rejects(authorizeDriverReceipt(fakeTx({ truck: { chauffeurId: "emp1" }, user: { active: false, role: "EMPLOYEE" } }), "t1", session), /UNAUTHENTICATED/)
  })
})

describe("menu", () => {
  it("« Ticket carburant » après les notes de frais, seulement si chauffeur", () => {
    const items = withFuelTicketNavItem(getNavItems("EMPLOYEE"), true)
    const i = items.findIndex((x) => x.href === "/ticket-carburant")
    assert.equal(items[i - 1].href, "/mes-notes-de-frais")
    assert.equal(withFuelTicketNavItem(getNavItems("EMPLOYEE"), false).some((x) => x.href === "/ticket-carburant"), false)
  })
})
