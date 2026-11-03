/**
 * PLV2-DOC-RH-002 — banc de mesure de l'OCR local sur pièces synthétiques (valeurs attendues connues).
 * `npx tsx tests/hr-documents/ocr/benchmark.ts [dossier]` : tableau par pièce et par champ, temps de lecture.
 * Avec un dossier, écrit aussi les pièces générées pour contrôle visuel. Aucune donnée réelle.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { recognize } from "../../../src/lib/hr-documents/recognition/engine"
import { readDocument } from "../../../src/lib/hr-documents/recognition/ocr"
import { buildFixtures, type Expected } from "./fixtures"

const FIELDS = ["category", "lastName", "firstNames", "birthDate", "sex", "nationality", "expiryDate", "documentNumberEnd", "period"] as const
type FieldName = (typeof FIELDS)[number]

async function main() {
const fixtures = await buildFixtures()
const dir = process.argv[2]
if (dir) { mkdirSync(dir, { recursive: true }); for (const f of fixtures) writeFileSync(join(dir, f.name.replace(/[^\p{L}\d]+/gu, "_") + "." + (f.kind === "jpeg" ? "jpg" : f.kind)), f.bytes) }

const tally = new Map<FieldName, { ok: number; total: number; wrong: number }>()
const rows: string[] = []
const now = new Date("2026-11-03T12:00:00Z")
for (const f of fixtures) {
  const reading = await readDocument(f.bytes, f.kind)
  const { text, ...summary } = reading
  const p = recognize({ text, fileName: f.fileName, employees: [], now, reading: summary })
  const got: Partial<Record<FieldName, { value: string; source: string } | null>> = {
    category: p.category, period: p.period,
    lastName: p.identity?.lastName ?? null, firstNames: p.identity?.firstNames ?? null, birthDate: p.identity?.birthDate ?? null,
    sex: p.identity?.sex ?? null, nationality: p.identity?.nationality ?? null, expiryDate: p.identity?.expiryDate ?? null,
    documentNumberEnd: p.identity?.documentNumberEnd ? { value: p.identity.documentNumberEnd, source: "MRZ" } : null,
  }
  const cells: string[] = []
  for (const k of FIELDS) {
    const want = (f.expected as Expected)[k]
    if (want === undefined || (k === "category" && want === "")) { cells.push("—"); continue }
    const t = tally.get(k) ?? { ok: 0, total: 0, wrong: 0 }
    t.total++
    const g = got[k]
    const ok = !!g && String(g.value).toUpperCase() === String(want).toUpperCase()
    if (ok) t.ok++
    else if (g) t.wrong++
    tally.set(k, t)
    // Valeur lue fausse ≠ champ laissé vide : un champ vide porte son motif, un champ faux doit être corrigé à la main.
    cells.push(ok ? `✅ ${g!.source}` : g ? "❌ faux" : `⬜ ${p.identity?.missing[k as keyof typeof p.identity.missing] ?? "vide"}`)
  }
  rows.push(`| ${f.name} | ${reading.status}${reading.reason ? ` (${reading.reason})` : ""} | ${reading.rotation ?? "—"} | ${reading.mrzFound ? (p.identity?.mrzChecksValid ? "valide" : "invalide") : "non"} | ${(reading.durationMs / 1000).toFixed(1)} s | ${cells.join(" | ")} |`)
  process.stderr.write(".")
}
process.stderr.write("\n")
console.log(`| Pièce | Lecture | Rotation | MRZ | Temps | ${FIELDS.join(" | ")} |`)
console.log(`|${"---|".repeat(5 + FIELDS.length)}`)
for (const r of rows) console.log(r)
console.log("\n| Champ | Réussis | Faux | Vides | Taux |\n|---|---|---|---|---|")
for (const k of FIELDS) {
  const t = tally.get(k)
  if (t) console.log(`| ${k} | ${t.ok}/${t.total} | ${t.wrong} | ${t.total - t.ok - t.wrong} | ${Math.round((100 * t.ok) / t.total)} % |`)
}
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
