import type { NormalizedExtraction, DeterministicPostEnrichmentContext } from "./extraction-normalize"
import { catalogWarning } from "./extraction.schema"
import { evidenceQuoteInHaystack } from "./anthropic-extraction.prompt"

const identity = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "")

/** Explicit business roles only; never infer a contracting company from a domain. */
export function guardClientRoles(result: NormalizedExtraction, body: string): void {
  const { fields, confidenceData, evidenceData, warnings } = result
  const client = fields.clientName
  if (!client) return
  const candidates = [...body.matchAll(/(?:notre\s+client(?:\s+final)?|client\s+final)\s*:\s*([^\r\n]+)/gi)]
  const visual = evidenceData.endClientName
  if (visual?.source === "ATTACHMENT_VISUAL" && visual.quote) {
    candidates.push(...visual.quote.matchAll(/client\s+final\s*:\s*([^\r\n]+)/gi))
  }
  if (!candidates.some(m => identity(m[1]) === identity(client))) return

  if (!fields.endClientName) {
    fields.endClientName = client
    confidenceData.endClientName = confidenceData.clientName ?? 0.5
    if (evidenceData.clientName) evidenceData.endClientName = evidenceData.clientName
  }
  fields.clientName = null
  delete confidenceData.clientName
  delete evidenceData.clientName
  warnings.unshift(catalogWarning("CLIENT_IDENTITY_AMBIGUOUS", { field: "clientName", source: "SERVICE" }))

  const donors = [...body.matchAll(/donneur\s+d['’]ordre\s*:\s*([^\r\n]+)/gi)]
    .filter(m => m[1].trim().length >= 2 && m[1].trim().length <= 100 && identity(m[1]) !== identity(client))
  if (new Set(donors.map(m => identity(m[1]))).size === 1) {
    fields.clientName = donors[0][1].trim()
    confidenceData.clientName = 0.7
    evidenceData.clientName = { source: "BODY", quote: donors[0][0].slice(0, 120) }
  }
}

/** A signature, approval, drawing revision or received timestamp is not an issue date. */
export function guardConsultationDate(result: NormalizedExtraction, ctx: DeterministicPostEnrichmentContext): void {
  const date = result.fields.clientConsultationDate
  if (!date) return
  const evidence = result.evidenceData.clientConsultationDate
  const quote = evidence?.quote ?? ""
  const text = evidence?.source === "SUBJECT" ? ctx.subject ?? "" : ctx.body
  const visual = evidence?.source === "ATTACHMENT_VISUAL"
  const sourceAllowed = visual || ["BODY", "SUBJECT", "ATTACHMENT_TEXT"].includes(evidence?.source ?? "")
  const verified = sourceAllowed && quote.trim() && (visual || evidenceQuoteInHaystack(text, quote))
  const source = (visual ? quote : text).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  const dates = [...source.matchAll(/(?:date\s+(?:de\s+)?(?:la\s+)?consultation|consultation\s+(?:(?:emise|datee)\s+)?(?:du|le)|date\s+d['’]emission\s+de\s+la\s+consultation)\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}\s+[a-z]+\s+\d{4})/gi)]
  const months = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"]
  const explicitMatch = dates.some(m => {
    const token = m[1].toLowerCase()
    if (/^\d{4}-/.test(token)) return token === date
    const parts = token.split(/[/.\-\s]+/)
    const month = /^\d+$/.test(parts[1]) ? Number(parts[1]) : months.indexOf(parts[1]) + 1
    const year = parts[2].length === 2 ? 2000 + Number(parts[2]) : Number(parts[2])
    return `${year}-${String(month).padStart(2, "0")}-${parts[0].padStart(2, "0")}` === date
  })
  if (verified && explicitMatch) return
  result.fields.clientConsultationDate = null
  delete result.confidenceData.clientConsultationDate
  delete result.evidenceData.clientConsultationDate
  result.warnings.unshift(catalogWarning("DATE_AMBIGUOUS", { field: "clientConsultationDate", source: "SERVICE" }))
}
