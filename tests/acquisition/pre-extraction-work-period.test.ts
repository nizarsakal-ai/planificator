import { it } from "node:test"
import assert from "node:assert/strict"
import { preExtractionWorkPeriod } from "@/lib/acquisition/policy/pre-extraction-work-period"
const now = new Date("2026-10-27T12:00:00Z")
it("MIPCOM past work range is obsolete, without using the received date", () => {
  assert.deepEqual(preExtractionWorkPeriod("MIPCOM 2026 - Démontage", "Dates : du 18 au 21 Octobre 2026", now), { kind: "OBSOLETE", start: "2026-10-18", end: "2026-10-21" })
})
it("future, ongoing and end-today work are eligible, using calendar days in Paris", () => {
  for (const [text, kind] of [["Dates :\ndu 02 au 06 novembre 2026", "FUTURE"], ["Intervention du 02/11/2026 au 06/11/2026", "FUTURE"], ["Travaux du 20.10.2026 au 30.10.2026", "ACTIVE"], ["Dates : du 2026-10-20 au 2026-10-27", "ACTIVE"]]) {
    assert.equal(preExtractionWorkPeriod(null, text, now).kind, kind)
  }
  assert.equal(preExtractionWorkPeriod(null, "Dates : du 26 au 27 octobre 2026", new Date("2026-10-27T23:15:00Z")).kind, "OBSOLETE")
})
it("missing, conflicting or invalid dates remain unknown for AI qualification", () => {
  for (const text of ["Bonjour", "Dates : du 18 au 21 octobre", "Dates : du 31/02/2026 au 02/03/2026", "Dates : du 30/10/2026 au 20/10/2026", "Intervention initialement du 18 au 21 octobre 2026, reportée", "Dates : du 18 au 21 octobre 2026\nMontage du 02 au 06 novembre 2026"]) assert.equal(preExtractionWorkPeriod(null, text, now).kind, "UNKNOWN", text)
  assert.equal(preExtractionWorkPeriod("Chantier du 02/11/2026 au 06/11/2026", "Intervention du 18/10/2026 au 21/10/2026", now).kind, "UNKNOWN")
})
it("event, consultation, signature and quoted dates cannot discard a worksite", () => {
  for (const body of ["Événement : du 18 au 21 octobre 2026", "Consultation du 18 au 21 octobre 2026", "Bonjour\nCordialement\nDates : du 18 au 21 octobre 2026", "Bonjour\nDe : client@example.fr\nIntervention du 18 au 21 octobre 2026", "Dates de signature : du 18 au 21 octobre 2026"]) assert.equal(preExtractionWorkPeriod(null, body, now).kind, "UNKNOWN", body)
})

it("MIPCOM overall dated period contains its two yearless detailed work phases", () => {
  const body = "Suite à nos échanges, voici les informations concernant le démontage du Mipcom\nDates : du 18 au 21 Octobre 2026\nPlanning :\nDu 18 au 19 Octobre : démontage des structures\nDu 20 au 21 Octobre : démontage planchers"
  assert.equal(preExtractionWorkPeriod("MIPCOM 2026 - Démontage", body, now).kind, "OBSOLETE")
  assert.equal(preExtractionWorkPeriod(null, "Dates : du 18 au 21 octobre 2026\nMontage du 02 au 06 novembre", now).kind, "UNKNOWN")
})
