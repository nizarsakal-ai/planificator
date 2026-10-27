import { isValidCalendarIsoDate } from "@/lib/acquisition/extraction/extraction.schema"
import { classifyWorkPeriod } from "./work-period-classification"

const months = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"]
const monthPattern = months.join("|")
const token = `(?:20\\d{2}-\\d{2}-\\d{2}|\\d{1,2}(?:[/.]\\d{1,2}(?:[/.]20\\d{2})?|\\s+(?:${monthPattern})(?:\\s+20\\d{2})?)?)`
const range = new RegExp(`\\bdu\\s+(${token})\\s+au\\s+(${token})\\b`, "g")
type Day = { day: number; month?: number; year?: number }
function day(text: string): Day {
  const iso = text.match(/^(20\d{2})-(\d{2})-(\d{2})$/)
  if (iso) return { year: +iso[1], month: +iso[2], day: +iso[3] }
  const parts = text.split(/[/.\s]+/)
  return { day: +parts[0], month: parts[1] ? (months.includes(parts[1]) ? months.indexOf(parts[1]) + 1 : +parts[1]) : undefined, year: parts[2] ? +parts[2] : undefined }
}
function ymd(d: Day): string | null {
  if (!d.year || !d.month) return null
  const value = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
  return isValidCalendarIsoDate(value) ? value : null
}

/** Local routing only: explicit work ranges, never receipt dates, signatures or inferred years. */
export function preExtractionWorkPeriod(subject: string | null, body: string, now: Date) {
  const normalize = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
  const subjectText = normalize(subject ?? "")
  const bodyText = normalize(body).split(/\n\s*(?:de\s*:|from\s*:|on .+wrote:|le .+ecrit\s*:|-{2,}.*(?:message|forward|transf)|cordialement|bien cordialement)/i)[0]
  if (/\b(?:reporte|annule|initialement|anciennes? dates?)\b/.test(subjectText + "\n" + bodyText)) return { kind: "UNKNOWN" as const }
  const candidates: Array<{ start: string; end: string }> = []
  let invalid = false
  const incomplete: Array<{ a: Day; b: Day }> = []
  for (const [text, isSubject] of [[subjectText, true], [bodyText, false]] as const) {
    for (const line of text.replace(/(dates?\s*:)\s*\n\s*(du\b)/g, "$1 $2").split("\n")) {
      if (!isSubject && !/\b(?:dates?\s*:|intervention\b|montage\b|demontage\b|travaux\b|prestation\b|chantier\b|periode\b)/.test(line)) continue
      if (/\b(?:evenement|salon|signature|facture|consultation\s+(?:du|le))\b/.test(line)) continue
      for (const match of line.matchAll(range)) {
        const a = day(match[1]), b = day(match[2])
        a.month ??= b.month; b.month ??= a.month
        a.year ??= b.year; b.year ??= a.year
        if (!a.year && !b.year) { incomplete.push({ a, b }); continue }
        const start = ymd(a), end = ymd(b)
        if (!start || !end || start > end) { invalid = true; continue }
        candidates.push({ start, end })
      }
    }
  }
  const unique = [...new Map(candidates.map(c => [c.start + c.end, c])).values()]
  // A complete overall period may contain a detailed schedule (e.g. MIPCOM).
  // Missing years are resolved only inside that explicit same-year envelope.
  const envelope = unique.find(c => unique.every(other => c.start <= other.start && c.end >= other.end))
  if (invalid || !envelope) return { kind: "UNKNOWN" as const }
  for (const { a, b } of incomplete) {
    if (envelope.start.slice(0, 4) !== envelope.end.slice(0, 4)) return { kind: "UNKNOWN" as const }
    const start = ymd({ ...a, year: +envelope.start.slice(0, 4) })
    const end = ymd({ ...b, year: +envelope.start.slice(0, 4) })
    if (!start || !end || start > end || start < envelope.start || end > envelope.end) return { kind: "UNKNOWN" as const }
  }
  const dates = envelope
  const kind = classifyWorkPeriod(new Date(dates.start + "T00:00:00Z"), new Date(dates.end + "T00:00:00Z"), now)
  return { kind, ...dates }
}
