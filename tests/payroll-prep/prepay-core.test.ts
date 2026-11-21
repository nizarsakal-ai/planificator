/**
 * Lot H Planificator V2 : pré-paie — règles pures (période, jours ouvrés, variables, contrôles, export CSV sûr) et
 * modèle DSN (format seulement, jeu synthétique). Attendus calculés à la main : octobre 2026 commence un jeudi.
 */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import {
  PREPAY_ERRORS, blockingCount, businessDaysInMonth, computePrepay, csvCell, eurosPlain, hoursDecimal, parseAmount, readSnapshot, toCsv, validateLabel, validatePeriod, openableMonths,
} from "@/lib/payroll-prep/prepay.core"
import { DSN_DISCLAIMER, RUBRICS, luhnValid, nirValid, renderDsn, validateDsn, type DsnLine } from "@/lib/payroll-prep/dsn-model"
import { isPayrollPrepEnabled } from "@/lib/payroll-prep/prepay-feature-flag"

const D = (s: string) => new Date(`${s}T00:00:00Z`)
/** Portage sur 90ae644 : aucun littéral BigInt (cible ES2017). */
const N = (v: number) => BigInt(v)
const I = (s: string) => new Date(s)
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")

describe("période et jours ouvrés", () => {
  it("mois de 2000 à 2100, jamais futur ; drapeau désactivé par défaut", () => {
    const today = D("2026-11-05")
    assert.deepEqual(validatePeriod(2026, 11, today), { ok: true, value: { year: 2026, month: 11 } })
    for (const [y, m] of [[2026, 12], [1999, 12], [2026, 13], [2026, 0], [2026.5, 1]]) assert.deepEqual(validatePeriod(y, m, today), { ok: false, error: PREPAY_ERRORS.period }, `${y}-${m}`)
    assert.equal(isPayrollPrepEnabled({}), false)
    assert.equal(isPayrollPrepEnabled({ PAYROLL_PREP_ENABLED: "true" }), true)
  })
  it("jours ouvrés du lundi au vendredi, limités au mois", () => {
    assert.deepEqual(businessDaysInMonth(D("2026-10-30"), D("2026-11-03"), 2026, 11), ["2026-11-02", "2026-11-03"])
    assert.deepEqual(businessDaysInMonth(D("2026-10-30"), D("2026-11-03"), 2026, 10), ["2026-10-30"])
    assert.deepEqual(businessDaysInMonth(D("2026-10-31"), D("2026-11-01"), 2026, 10), [], "samedi et dimanche")
    assert.equal(businessDaysInMonth(D("2026-10-01"), D("2026-10-31"), 2026, 10).length, 22)
  })
})

describe("variables et contrôles", () => {
  const facts = {
    employees: [{ id: "e2", firstName: "Léo", lastName: "Petit", active: true }, { id: "e1", firstName: "Ana", lastName: "Martin", active: true }],
    timeclocks: [
      { employeeId: "e1", date: D("2026-10-01"), checkInAt: I("2026-10-01T08:00:00Z"), checkOutAt: I("2026-10-01T16:30:00Z") },
      { employeeId: "e1", date: D("2026-10-02"), checkInAt: I("2026-10-02T07:00:00Z"), checkOutAt: I("2026-10-02T15:00:00Z") },
      { employeeId: "e1", date: D("2026-10-05"), checkInAt: I("2026-10-05T07:00:00Z"), checkOutAt: null },
      { employeeId: "e1", date: D("2026-10-06"), checkInAt: I("2026-10-06T10:00:00Z"), checkOutAt: I("2026-10-06T09:00:00Z") },
      { employeeId: "e2", date: D("2026-10-14"), checkInAt: I("2026-10-14T08:00:00Z"), checkOutAt: I("2026-10-14T12:00:00Z") },
      { employeeId: "e2", date: D("2026-09-30"), checkInAt: I("2026-09-30T08:00:00Z"), checkOutAt: I("2026-09-30T12:00:00Z") },
    ],
    absences: [
      { id: "a2", employeeId: "e2", type: "SICK" as const, status: "APPROVED" as const, startDate: D("2026-10-15"), endDate: D("2026-10-19") },
      { id: "a1", employeeId: "e2", type: "VACATION" as const, status: "APPROVED" as const, startDate: D("2026-10-12"), endDate: D("2026-10-16") },
      { id: "a3", employeeId: "e1", type: "TRAINING" as const, status: "PENDING" as const, startDate: D("2026-10-20"), endDate: D("2026-10-20") },
      { id: "a4", employeeId: "e1", type: "UNPAID" as const, status: "REJECTED" as const, startDate: D("2026-10-21"), endDate: D("2026-10-23") },
      { id: "a5", employeeId: "e1", type: "OTHER" as const, status: "APPROVED" as const, startDate: D("2026-09-28"), endDate: D("2026-10-02") },
    ],
    variables: [
      { employeeId: "e1", kind: "BONUS" as const, amountCents: N(15_000) }, { employeeId: "e1", kind: "BONUS" as const, amountCents: N(5_050) },
      { employeeId: "e2", kind: "EXPENSE" as const, amountCents: N(1_234) }, { employeeId: "eX", kind: "BONUS" as const, amountCents: N(1) },
    ],
  }
  const r = computePrepay(2026, 10, facts)
  it("heures et jours des seuls pointages complets du mois ; absences validées en jours ouvrés, chevauchement compté une fois", () => {
    assert.deepEqual(r.lines.map((l) => l.name), ["Martin Ana", "Petit Léo"])
    const [e1, e2] = r.lines
    assert.deepEqual([e1.workedMinutes, e1.workedDays, e1.bonusCents, e1.expenseCents], [990, 2, "20050", "0"])
    assert.deepEqual(e1.absenceDays, { VACATION: 0, SICK: 0, UNPAID: 0, TRAINING: 0, OTHER: 2 }, "1er et 2 octobre seulement (septembre exclu), absence refusée et en attente non comptées")
    assert.deepEqual([e2.workedMinutes, e2.workedDays, e2.bonusCents, e2.expenseCents], [240, 1, "0", "1234"])
    assert.deepEqual(e2.absenceDays, { VACATION: 5, SICK: 1, UNPAID: 0, TRAINING: 0, OTHER: 0 }, "maladie : 15 et 16 déjà en congés, week-end exclu, reste le lundi 19")
  })
  it("contrôles triés : pointage incomplet, incohérent et absence en attente bloquants ; pointage un jour d'absence signalé", () => {
    assert.deepEqual(r.anomalies.map((a) => [a.day, a.employeeId, a.code, a.blocking]), [
      ["2026-10-01", "e1", "WORK_ON_ABSENCE", false],
      ["2026-10-02", "e1", "WORK_ON_ABSENCE", false],
      ["2026-10-05", "e1", "INCOMPLETE_TIMECLOCK", true],
      ["2026-10-06", "e1", "INVALID_TIMECLOCK", true],
      ["2026-10-14", "e2", "WORK_ON_ABSENCE", false],
      ["2026-10-20", "e1", "PENDING_ABSENCE", true],
    ])
    assert.equal(blockingCount(r), 3)
    const longDay = computePrepay(2026, 10, { ...facts, absences: [], timeclocks: [{ employeeId: "e1", date: D("2026-10-07"), checkInAt: I("2026-10-07T00:00:00Z"), checkOutAt: I("2026-10-07T16:01:00Z") }] })
    assert.equal(longDay.anomalies[0].code, "INVALID_TIMECLOCK", "plus de 16 h")
  })
})

describe("formats et export", () => {
  it("heures en centièmes et euros sans flottant", () => {
    assert.deepEqual([hoursDecimal(990), hoursDecimal(240), hoursDecimal(1), hoursDecimal(9130), hoursDecimal(0)], ["16,50", "4,00", "0,02", "152,17", "0,00"])
    assert.deepEqual([eurosPlain("20050"), eurosPlain("5"), eurosPlain("0"), eurosPlain("123456789")], ["200,50", "0,05", "0,00", "1234567,89"])
  })
  it("montant saisi : positif, deux décimales au plus, plafonné ; libellé borné", () => {
    assert.deepEqual(parseAmount("1 234,5"), { ok: true, value: N(123_450) })
    assert.deepEqual(parseAmount("10000000"), { ok: true, value: N(1_000_000_000) })
    for (const bad of ["0", "-5", "12,345", "10000000,01", "abc", ""]) assert.deepEqual(parseAmount(bad), { ok: false, error: PREPAY_ERRORS.amount }, bad)
    assert.deepEqual(validateLabel(" Prime de panier "), { ok: true, value: "Prime de panier" })
    assert.deepEqual(validateLabel("x"), { ok: false, error: PREPAY_ERRORS.label })
  })
  it("CSV : en-tête, séparateur « ; », CRLF, BOM ; formules neutralisées et guillemets échappés", () => {
    assert.equal(csvCell("=SOMME(A1:A9)"), "'=SOMME(A1:A9)")
    assert.equal(csvCell("+33 6"), "'+33 6")
    assert.equal(csvCell("@cmd"), "'@cmd")
    assert.equal(csvCell("a;b"), '"a;b"')
    assert.equal(csvCell('Dupont "Jo"'), '"Dupont ""Jo"""')
    const csv = toCsv(computePrepay(2026, 10, { employees: [{ id: "e1", firstName: "Ana", lastName: "=Martin", active: true }], timeclocks: [], absences: [], variables: [{ employeeId: "e1", kind: "BONUS", amountCents: N(20_050) }] }).lines)
    assert.ok(csv.startsWith("﻿Salarié;Identifiant;Heures travaillées;Jours travaillés;Congés payés (j);Maladie (j);Sans solde (j);Formation (j);Autre (j);Primes (€);Frais (€)\r\n"))
    assert.ok(csv.endsWith("'=Martin Ana;e1;0,00;0;0;0;0;0;0;200,50;0,00\r\n"))
  })
  it("instantané relu prudemment", () => {
    assert.deepEqual(readSnapshot({ year: 2026, month: 10, closedOn: "2026-11-05", lines: [], warnings: [] }), { year: 2026, month: 10, closedOn: "2026-11-05", lines: [], warnings: [] })
    for (const bad of [null, [], { year: 2026, month: 10, closedOn: "2026-02-30", lines: [], warnings: [] }, { year: 2026, month: 10, closedOn: "2026-11-05", lines: {}, warnings: [] }]) assert.equal(readSnapshot(bad), null)
  })
})

describe("modèle DSN : format seulement, jeu synthétique", () => {
  // Identifiants SYNTHÉTIQUES calculés pour respecter les clés (aucune personne ni entreprise réelle visée).
  const SIREN = "999990005", NIC = "00004", NIR = "185059999900181"
  const VALID: DsnLine[] = [
    { id: "S10.G00.00.001", value: "Planificator" }, { id: "S10.G00.00.002", value: "Editeur fictif" }, { id: "S10.G00.00.003", value: "0.1-essai" },
    { id: "S10.G00.00.005", value: "01" }, { id: "S10.G00.01.001", value: SIREN }, { id: "S10.G00.01.002", value: NIC },
    { id: "S20.G00.05.001", value: "01" }, { id: "S20.G00.05.005", value: "01102026" },
    { id: "S21.G00.06.001", value: SIREN }, { id: "S21.G00.11.001", value: NIC },
    { id: "S21.G00.30.001", value: NIR }, { id: "S21.G00.30.002", value: "FICTIF" }, { id: "S21.G00.30.004", value: "Salarie" }, { id: "S21.G00.30.006", value: "15051985" },
    { id: "S21.G00.51.001", value: "01102026" }, { id: "S21.G00.51.002", value: "31102026" }, { id: "S21.G00.51.013", value: "0.00" },
  ]
  it("clés publiques : Luhn (SIREN, SIRET) et clé 97 du NIR, Corse comprise", () => {
    assert.equal(luhnValid(SIREN), true)
    assert.equal(luhnValid(`${SIREN}${NIC}`), true)
    assert.equal(luhnValid("999990006"), false)
    assert.equal(nirValid(NIR), true)
    assert.equal(nirValid("185059999900182"), false, "mauvaise clé")
    assert.equal(nirValid("290122A12345644"), true, "Corse : 2A compté 19")
    assert.equal(nirValid("385059999900181"), false, "premier chiffre 1 ou 2")
  })
  it("modèle valide : aucun écart, rendu « rubrique,'valeur' » ; code d'envoi d'essai seulement", () => {
    assert.deepEqual(validateDsn(VALID), [])
    const r = renderDsn(VALID)
    assert.ok(r.ok)
    if (r.ok) assert.ok(r.text.startsWith("S10.G00.00.001,'Planificator'\nS10.G00.00.002,'Editeur fictif'\n") && r.text.endsWith("S21.G00.51.013,'0.00'\n"))
    assert.ok(RUBRICS.every((x) => /^S\d{2}\.G\d{2}\.\d{2}\.\d{3}$/.test(x.id)))
    assert.match(DSN_DISCLAIMER, /Aucun dépôt, aucune cotisation calculée, aucune conformité réglementaire revendiquée/)
  })
  it("écarts détectés : SIREN, NIR, date, montant, apostrophe, rubrique inconnue, envoi réel, rubrique obligatoire absente ; rendu refusé", () => {
    const set = (id: string, value: string) => VALID.map((l) => (l.id === id ? { id, value } : l))
    const msg = (lines: DsnLine[]) => validateDsn(lines).map((i) => `${i.id}:${i.message}`)
    assert.ok(msg(set("S21.G00.06.001", "999990006")).some((m) => m.startsWith("S21.G00.06.001:SIREN invalide")))
    assert.ok(msg(set("S21.G00.30.001", "185059999900182")).includes("S21.G00.30.001:NIR invalide (format ou clé)"))
    assert.ok(msg(set("S21.G00.30.006", "31022026")).includes("S21.G00.30.006:date JJMMAAAA invalide"))
    assert.ok(msg(set("S21.G00.51.013", "12.5")).some((m) => m.startsWith("S21.G00.51.013:montant attendu")))
    assert.ok(msg(set("S21.G00.30.002", "D'ARC")).some((m) => m.includes("caractère interdit")))
    assert.ok(msg([...VALID, { id: "S21.G00.81.004", value: "1" }]).includes("S21.G00.81.004:rubrique hors du sous-ensemble du modèle"))
    const real = msg(set("S10.G00.00.005", "02"))
    assert.ok(real.includes("S10.G00.00.005:code attendu parmi 01") && real.includes("S10.G00.00.005:le modèle n'admet que l'envoi d'essai"))
    assert.ok(msg(VALID.filter((l) => l.id !== "S10.G00.01.002")).includes("S10.G00.01.002:rubrique obligatoire du modèle absente (émetteur)"))
    assert.equal(renderDsn(set("S21.G00.30.001", "1")).ok, false)
  })
  it("contrôle statique : aucun module réseau, aucun dépôt, aucune donnée réelle lue par le modèle DSN", () => {
    const c = code(readFileSync("src/lib/payroll-prep/dsn-model.ts", "utf8"))
    assert.doesNotMatch(c, /\bfetch\(|from "node:(?:http|https|net)"|https?:\/\/|prisma|process\.env/)
    for (const f of readdirSync("src/lib/payroll-prep")) assert.doesNotMatch(code(readFileSync(`src/lib/payroll-prep/${f}`, "utf8")), /\bfetch\(|net-entreprises\.fr\/|https?:\/\//, f)
  })
})

describe("mois proposés à l'ouverture (liste déroulante, compatible Safari)", () => {
  it("mois en cours puis précédents, sans les mois ouverts, valeur AAAA-MM acceptée par l'action", () => {
    const m = openableMonths(D("2026-11-21"), [{ year: 2026, month: 11 }, { year: 2026, month: 9 }], 4)
    assert.deepEqual(m.map((x) => x.value), ["2026-10", "2026-08"])
    assert.equal(m[0].label, "octobre 2026")
    for (const x of m) assert.match(x.value, /^\d{4}-\d{2}$/)
  })
  it("passage d'année et aucun mois futur", () => {
    const m = openableMonths(D("2027-01-05"), [], 3)
    assert.deepEqual(m.map((x) => x.value), ["2027-01", "2026-12", "2026-11"])
    for (const x of m) { const [y, mo] = x.value.split("-").map(Number); assert.equal(validatePeriod(y, mo, D("2027-01-05")).ok, true) }
  })
  it("la page n'utilise plus <input type=\"month\">", () => {
    const page = readFileSync("src/app/(dashboard)/pre-paie/page.tsx", "utf8")
    assert.doesNotMatch(page, /<Input[^>]*type="month"/)
    assert.match(page, /openableMonths\(parisToday\(serverNow\(\)\), periods\)/)
  })
})
