// SPEC-INVOICE-IMPORT-001 — extraction des champs d'une pièce PDF ou image.
// 1) PDF avec couche texte : lecture `unpdf` (lecteur existant) + heuristiques ; rien n'est inventé (champ absent ⇒ à saisir).
// 2) PDF scanné ou image : OCR EXISTANT des factures fournisseurs (`getOcrProvider`, drapeau BILLING_OCR_ENABLED), appelé tel quel.
//    Cet OCR identifie l'ÉMETTEUR : s'il n'est pas la société, la pièce est une facture fournisseur (orientée vers le parcours dédié).
// Aucune écriture en base ici.
import { extractPdfTextLayer } from "@/lib/acquisition/extraction/pdf-text-extract"
import { OcrError, getOcrProvider, type OcrExtraction } from "@/lib/accounting/c5/ocr-provider"
import { completeAmounts, nameKey, parseImportAmount, parseImportDate } from "./normalize"
import type { ImportRowKind } from "./types"

export interface ExtractedDocument {
  kind: ImportRowKind | null
  number: string | null
  issueDate: string | null
  dueDate: string | null
  htCents: bigint | null
  vatCents: bigint | null
  ttcCents: bigint | null
  /** Émetteur lu par l'OCR (jamais utilisé comme client). */
  issuerName: string | null
  issuerSiret: string | null
  creditedNumber: string | null
  text: string
  method: "TEXT" | "OCR" | "NONE"
  note: string | null
}

const AMOUNT = String.raw`(-?\d{1,3}(?:[   .]?\d{3})*(?:[.,]\d{2}))\s*(?:€|EUR)?`
const DATE = String.raw`(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})`

function firstAmount(text: string, labels: string): bigint | null {
  const m = new RegExp(`(?:${labels})[^\\d\\n-]{0,40}${AMOUNT}`, "i").exec(text)
  return m ? parseImportAmount(m[1]) : null
}
function firstDate(text: string, labels: string): string | null {
  const m = new RegExp(`(?:${labels})[^\\d\\n]{0,30}${DATE}`, "i").exec(text)
  return m ? parseImportDate(m[1]) : null
}

/** Heuristiques sur le texte d'une facture française ; tolérantes, jamais bloquantes. */
export function parseInvoiceText(raw: string): Omit<ExtractedDocument, "issuerName" | "issuerSiret" | "method" | "note"> {
  const text = raw.replace(/\r/g, "")
  const isCredit = /\b(facture d['’ ]avoir|avoir n|note de cr[ée]dit|credit note)\b/i.test(text) || /^\s*avoir\b/im.test(text)
  const numberMatch =
    /(?:facture|avoir|invoice|credit note)\s*(?:d['’ ]avoir\s*)?(?:n[°ºo.]?|num[ée]ro|#)\s*:?\s*([A-Z0-9][A-Z0-9/_.-]{1,40})/i.exec(text) ??
    /(?:n[°º]|num[ée]ro)\s*(?:de\s+(?:facture|pi[èe]ce))?\s*:?\s*([A-Z0-9][A-Z0-9/_.-]{2,40})/i.exec(text)
  const credited = isCredit ? /(?:sur|de)\s+la\s+facture\s*(?:n[°ºo.]?|num[ée]ro)?\s*:?\s*([A-Z0-9][A-Z0-9/_.-]{2,40})/i.exec(text) : null
  const amounts = completeAmounts({
    ht: firstAmount(text, "total\\s+(?:net\\s+)?h\\.?t\\.?|montant\\s+h\\.?t\\.?|total\\s+hors\\s+taxes?"),
    vat: firstAmount(text, "total\\s+t\\.?v\\.?a\\.?|montant\\s+t\\.?v\\.?a\\.?|t\\.?v\\.?a\\.?\\s*(?:\\(?\\d{1,2}(?:[.,]\\d)?\\s*%\\)?)?"),
    ttc: firstAmount(text, "total\\s+t\\.?t\\.?c\\.?|montant\\s+t\\.?t\\.?c\\.?|net\\s+[àa]\\s+payer|total\\s+[àa]\\s+payer"),
  })
  return {
    kind: isCredit ? "CREDIT_NOTE" : numberMatch || amounts.ttc !== null ? "INVOICE" : null,
    number: numberMatch ? numberMatch[1].replace(/[.,;:]+$/, "").slice(0, 64) : null,
    issueDate: firstDate(text, "date\\s+d['’ ][ée]mission|date\\s+de\\s+(?:la\\s+)?facture|date\\s+de\\s+facturation|[ée]mise?\\s+le|date") ,
    dueDate: firstDate(text, "date\\s+d['’ ][ée]ch[ée]ance|[ée]ch[ée]ance|date\\s+limite\\s+de\\s+paiement|[àa]\\s+r[ée]gler\\s+avant\\s+le"),
    htCents: amounts.ht, vatCents: amounts.vat, ttcCents: amounts.ttc,
    creditedNumber: credited ? credited[1].replace(/[.,;:]+$/, "").slice(0, 64) : null, text,
  }
}

const EMPTY = (note: string | null, method: ExtractedDocument["method"] = "NONE", text = ""): ExtractedDocument => ({
  kind: null, number: null, issueDate: null, dueDate: null, htCents: null, vatCents: null, ttcCents: null, issuerName: null, issuerSiret: null, creditedNumber: null, text, method, note,
})

export interface OwnCompany { name: string; siret: string | null }

/** L'émetteur lu est-il la société elle-même ? SIRET identique, sinon nom concordant. Indéterminé ⇒ null. */
export function issuerIsOwnCompany(issuerName: string | null, issuerSiret: string | null, own: OwnCompany): boolean | null {
  const ownSiret = (own.siret ?? "").replace(/\s/g, "")
  if (issuerSiret && ownSiret) return issuerSiret === ownSiret
  if (!issuerName) return null
  const a = nameKey(issuerName), b = nameKey(own.name)
  if (!a || !b) return null
  return a === b || a.includes(b) || b.includes(a)
}

function fromOcr(o: OcrExtraction, own: OwnCompany): ExtractedDocument {
  const mine = issuerIsOwnCompany(o.supplier, o.siret, own)
  return {
    kind: mine === false ? "SUPPLIER" : "INVOICE", number: o.invoiceNumber, issueDate: o.date, dueDate: null,
    htCents: o.totalHTCents, vatCents: o.vatCents, ttcCents: o.totalTTCCents, issuerName: o.supplier, issuerSiret: o.siret, creditedNumber: null,
    text: "", method: "OCR",
    note: mine === null ? "Émetteur non identifié par la lecture automatique : vérifiez qu'il s'agit bien d'une facture émise par votre société." : "Lecture automatique d'un document scanné : client à choisir, champs à vérifier.",
  }
}

/** Extraction d'une pièce. Ne lève jamais : un échec devient une ligne à compléter à la main, avec sa raison. */
export async function extractDocument(file: { data: Buffer; mime: string }, own: OwnCompany): Promise<ExtractedDocument> {
  if (file.mime === "application/pdf") {
    const layer = await extractPdfTextLayer(file.data, { maxChars: 20_000, timeoutMs: 5_000 })
    if ((layer.status === "PDF_TEXT_EXTRACTED" || layer.status === "PDF_TEXT_TRUNCATED") && layer.text.replace(/\s/g, "").length >= 40) {
      const parsed = parseInvoiceText(layer.text)
      const incomplete = !parsed.number || !parsed.issueDate || parsed.ttcCents === null
      return { ...parsed, issuerName: null, issuerSiret: null, method: "TEXT", note: incomplete ? "Lecture partielle du PDF : complétez les champs manquants." : null }
    }
  }
  try {
    return fromOcr(await getOcrProvider().extract(file), own)
  } catch (e) {
    if (e instanceof OcrError) {
      return EMPTY(e.code === "OCR_DISABLED" ? "Document scanné : la lecture automatique (OCR) est désactivée, saisissez les champs." : "Lecture automatique indisponible pour ce document : saisissez les champs.")
    }
    throw e
  }
}
