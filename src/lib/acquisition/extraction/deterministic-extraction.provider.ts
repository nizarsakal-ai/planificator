/**
 * PLAN-ACQ-005B-2 — Provider déterministe (heuristiques durcies R1).
 * Aucun réseau / IA. Confidence ≤ 0.35. Pas de body→description auto.
 */

import { isValidCalendarIsoDate } from "@/lib/acquisition/extraction/extraction.schema"
import type {
  ExtractionProviderPort,
  ExtractionProviderResult,
  NormalizedExtractInput,
} from "@/lib/acquisition/extraction/extraction-provider.port"

const MAX_CONFIDENCE = 0.35
const QUOTE_MAX = 120

const GENERIC_SUBJECT =
  /^(?:(?:fw|fwd|re|tr)\s*:\s*)*(?:relance|devis|facture|bonjour|demande|consultation|transfert|sans objet|merci|info|information)\b/i

const STREET_RE =
  /\b\d{1,4}\s+(?:bis\s+|ter\s+)?(?:rue|avenue|av\.|bd|boulevard|chemin|place|impasse|all[eé]e|route|cours|quai)\b[^,\n]{3,80}/i

function clipQuote(text: string): string {
  const t = text.trim().replace(/\s+/g, " ")
  return t.length <= QUOTE_MAX ? t : t.slice(0, QUOTE_MAX)
}

function labeledValue(text: string, labels: RegExp): string | null {
  const m = text.match(labels)
  if (!m?.[1]) return null
  const v = m[1].trim().replace(/\s+/g, " ")
  return v.length >= 2 ? v.slice(0, 100) : null
}

function findWorksiteName(body: string): { value: string; quote: string } | null {
  const v = labeledValue(
    body,
    /(?:^|\n)\s*(?:chantier|projet|site)\s*[:\-–]\s*(.+?)(?:\n|$)/i
  )
  if (!v || v.length < 3) return null
  if (GENERIC_SUBJECT.test(v)) return null
  return { value: v.slice(0, 100), quote: clipQuote(v) }
}

function findClientName(body: string): { value: string; quote: string } | null {
  const v = labeledValue(
    body,
    /(?:^|\n)\s*(?:client|soci[eé]t[eé]|entreprise|raison sociale)\s*[:\-–]\s*(.+?)(?:\n|$)/i
  )
  if (!v || v.length < 2) return null
  return { value: v.slice(0, 100), quote: clipQuote(v) }
}

function findAddress(body: string): { value: string; quote: string; postalCode?: string } | null {
  const labeled = labeledValue(
    body,
    /(?:^|\n)\s*(?:adresse|address)\s*[:\-–]\s*(.+?)(?:\n|$)/i
  )
  if (labeled && labeled.length >= 8) {
    const cp = labeled.match(/\b(\d{5})\b/)
    return {
      value: labeled.slice(0, 500),
      quote: clipQuote(labeled),
      postalCode: cp?.[1],
    }
  }
  const street = body.match(STREET_RE)
  if (!street) return null
  const line = street[0].trim()
  const cpNearby = body
    .slice(Math.max(0, (street.index ?? 0) - 20), (street.index ?? 0) + line.length + 40)
    .match(/\b(\d{5})\b/)
  return {
    value: line.slice(0, 500),
    quote: clipQuote(line),
    postalCode: cpNearby?.[1],
  }
}

function findLabeledPostalCode(body: string): { value: string; quote: string } | null {
  const m = body.match(
    /(?:^|\n)\s*(?:cp|code\s*postal|postal)\s*[:\-–]?\s*(\d{5})\b/i
  )
  if (!m?.[1]) return null
  return { value: m[1], quote: clipQuote(m[0]) }
}

function findEmail(text: string): { value: string; quote: string } | null {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  if (!m) return null
  return { value: m[0].toLowerCase(), quote: clipQuote(m[0]) }
}

function findPhoneFr(text: string): { value: string; quote: string } | null {
  const m = text.match(/(?:\+33|0)\s*[1-9](?:[\s.-]*\d{2}){4}/)
  if (!m) return null
  const cleaned = m[0].replace(/[^\d+]/g, "")
  if (cleaned.length < 10) return null
  return { value: cleaned.slice(0, 32), quote: clipQuote(m[0]) }
}

function toIsoIfValid(y: number, m: number, d: number): string | null {
  const ymd = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  return isValidCalendarIsoDate(ymd) ? ymd : null
}

function findAllDates(text: string): { value: string; quote: string }[] {
  const out: { value: string; quote: string }[] = []
  const isoRe = /\b(20\d{2})-(\d{2})-(\d{2})\b/g
  let m: RegExpExecArray | null
  while ((m = isoRe.exec(text)) && out.length < 2) {
    const iso = toIsoIfValid(Number(m[1]), Number(m[2]), Number(m[3]))
    if (iso) out.push({ value: iso, quote: clipQuote(m[0]) })
  }
  if (out.length >= 2) return out
  const frRe = /\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g
  while ((m = frRe.exec(text)) && out.length < 2) {
    const iso = toIsoIfValid(Number(m[3]), Number(m[2]), Number(m[1]))
    if (iso) out.push({ value: iso, quote: clipQuote(m[0]) })
  }
  return out
}

function findReference(text: string): { value: string; quote: string } | null {
  const m = text.match(
    /(?:r[eé]f[eé]rence|ref\.?|consultation|dossier|affaire)\s*[:#]\s*([A-Z0-9][A-Z0-9._/-]{2,63})/i
  )
  if (!m?.[1]) return null
  return { value: m[1].toUpperCase().slice(0, 64), quote: clipQuote(m[0]) }
}

function detectInjectionHints(text: string): boolean {
  return /ignore\s+(all\s+)?(previous|prior)\s+instructions|system\s*prompt|<<\s*END\s*>>/i.test(
    text
  )
}

export class DeterministicExtractionProvider implements ExtractionProviderPort {
  async extract(input: NormalizedExtractInput): Promise<ExtractionProviderResult> {
    const started = Date.now()
    const body = input.normalizedText ?? ""
    const subject = input.subject
    const haystack = [subject ?? "", body].filter(Boolean).join("\n")

    const fields: ExtractionProviderResult["fields"] = {}
    const warnings: ExtractionProviderResult["warnings"] = []

    // Subject brut jamais worksiteName ; motif explicite dans le body uniquement.
    const worksite = findWorksiteName(body)
    if (worksite) {
      fields.worksiteName = {
        value: worksite.value,
        confidence: MAX_CONFIDENCE,
        evidence: { source: "BODY", quote: worksite.quote },
      }
    }

    const client = findClientName(body)
    if (client) {
      fields.clientName = {
        value: client.value,
        confidence: MAX_CONFIDENCE,
        evidence: { source: "BODY", quote: client.quote },
      }
    }

    const addr = findAddress(body)
    if (addr) {
      fields.address = {
        value: addr.value,
        confidence: 0.3,
        evidence: { source: "BODY", quote: addr.quote },
      }
      if (addr.postalCode) {
        fields.postalCode = {
          value: addr.postalCode,
          confidence: 0.3,
          evidence: { source: "BODY", quote: clipQuote(addr.postalCode) },
        }
      }
    } else {
      const cp = findLabeledPostalCode(body)
      if (cp) {
        fields.postalCode = {
          value: cp.value,
          confidence: 0.25,
          evidence: { source: "BODY", quote: cp.quote },
        }
      }
    }

    const email = findEmail(haystack)
    if (email) {
      fields.clientEmail = {
        value: email.value,
        confidence: MAX_CONFIDENCE,
        evidence: { source: "BODY", quote: email.quote },
      }
    }

    const phone = findPhoneFr(haystack)
    if (phone) {
      fields.clientPhone = {
        value: phone.value,
        confidence: 0.3,
        evidence: { source: "BODY", quote: phone.quote },
      }
    }

    const dates = findAllDates(haystack)
    if (dates[0]) {
      fields.requestedStartDate = {
        value: dates[0].value,
        confidence: 0.3,
        evidence: { source: "BODY", quote: dates[0].quote },
      }
    }
    if (dates[1]) {
      fields.requestedEndDate = {
        value: dates[1].value,
        confidence: 0.3,
        evidence: { source: "BODY", quote: dates[1].quote },
      }
    }

    const ref = findReference(haystack)
    if (ref) {
      fields.consultationReference = {
        value: ref.value,
        confidence: 0.35,
        evidence: { source: "BODY", quote: ref.quote },
      }
    }

    // Pas de description = body entier (R1 / B1).

    if (input.attachmentMetadata.length > 0) {
      fields.attachmentClassifications = {
        value: input.attachmentMetadata.slice(0, 50).map((a) => ({
          filename: a.filename.slice(0, 255),
          category: a.category,
        })),
        confidence: 0.35,
        evidence: {
          source: "ATTACHMENT_META",
          quote: clipQuote(input.attachmentMetadata[0].filename),
        },
      }
      for (const a of input.attachmentMetadata) {
        if (a.category === "UNSUPPORTED" || a.category === "UNKNOWN") {
          // Pas de filename dans message (catalogue fermé côté service).
          warnings.push({
            code: "UNSUPPORTED_ATTACHMENT_TYPE",
            field: "attachmentClassifications",
          })
        }
      }
    }

    if (detectInjectionHints(haystack)) {
      warnings.push({ code: "POTENTIAL_PROMPT_INJECTION" })
    }

    const hasStrong =
      Boolean(fields.worksiteName) ||
      Boolean(fields.clientName) ||
      Boolean(fields.address) ||
      Boolean(fields.consultationReference)

    if (!hasStrong) {
      warnings.push({ code: "CONTENT_INSUFFICIENT" })
    } else if (!fields.worksiteName && !fields.clientName) {
      warnings.push({ code: "PROVIDER_PARTIAL_RESULT" })
    }

    return {
      fields,
      warnings,
      providerMetadata: {
        providerId: "deterministic",
        model: "rules-v1",
        latencyMs: Date.now() - started,
      },
    }
  }
}

export const deterministicExtractionProvider = new DeterministicExtractionProvider()
