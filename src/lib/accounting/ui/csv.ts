// Exports CSV comptables (SPEC-ACC-A2) : séparateur « ; », décimales à la virgule, BOM UTF-8 pour Excel.
// Les cellules texte sont neutralisées contre l'injection de formules (CWE-1236).

const FORMULA_START = /^[=+\-@\t\r]/

export function csvText(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return /[";\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Montant en centimes → « 1234,56 » / « -1234,56 » (sans séparateur de milliers, lisible par les tableurs FR). */
export function csvAmount(cents: bigint): string {
  const neg = cents < BigInt(0)
  const abs = neg ? -cents : cents
  return `${neg ? "-" : ""}${(abs / BigInt(100)).toString()},${(abs % BigInt(100)).toString().padStart(2, "0")}`
}

export type CsvCell = { text: string } | { amount: bigint } | { raw: string }

export function buildCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const line = (cells: readonly CsvCell[]) =>
    cells.map((c) => ("text" in c ? csvText(c.text) : "amount" in c ? csvAmount(c.amount) : csvText(c.raw))).join(";")
  return "﻿" + [header.map(csvText).join(";"), ...rows.map(line)].join("\r\n") + "\r\n"
}

/** Nom de fichier sûr pour Content-Disposition (ASCII, sans guillemets). */
export function csvFilename(base: string): string {
  return base.normalize("NFD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "export"
}
