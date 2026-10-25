// Forme canonique v1 et chaînage d'intégrité (SPEC-ACC-A §3 bis « Chaînage »).
import { createHash } from "node:crypto"

export const CANONICAL_VERSION = 1

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** JSON aux clés triées, sans espaces, chaînes normalisées NFC. Les nombres doivent être des entiers sûrs. */
export function canonicalJson(value: Json): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("CANONICAL_NUMBER_NOT_SAFE_INTEGER")
    return String(value)
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"))
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  const keys = Object.keys(value).sort()
  return "{" + keys.map((k) => JSON.stringify(k.normalize("NFC")) + ":" + canonicalJson(value[k])).join(",") + "}"
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function genesisHash(companyId: string, journalId: string): string {
  return sha256Hex(`GENESIS|${companyId}|${journalId}`)
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)
const isoSecond = (d: Date) => d.toISOString().slice(0, 19) + "Z"

export interface ChainEntry {
  companyId: string
  journalId: string
  fiscalYearId: string
  number: number
  entryDate: Date
  documentDate: Date | null
  documentRef: string | null
  label: string
  validatedAt: Date
  validatedById: string
  sourceType: string | null
  sourceId: string | null
  sourceVersion: number | null
  reversalOfId: string | null
  closingEntry: boolean
  lines: { position: number; accountId: string; label: string | null; debitCents: bigint; creditCents: bigint; vatRateBp: number | null }[]
}

export function canonicalEntry(entry: ChainEntry, prevHash: string): string {
  const lines = [...entry.lines].sort((a, b) => a.position - b.position).map((l) => ({
    position: l.position,
    accountId: l.accountId,
    label: l.label,
    debitCents: l.debitCents.toString(),
    creditCents: l.creditCents.toString(),
    vatRateBp: l.vatRateBp,
  }))
  return canonicalJson({
    version: CANONICAL_VERSION,
    companyId: entry.companyId,
    journalId: entry.journalId,
    fiscalYearId: entry.fiscalYearId,
    number: entry.number,
    entryDate: isoDate(entry.entryDate),
    documentDate: entry.documentDate ? isoDate(entry.documentDate) : null,
    documentRef: entry.documentRef,
    label: entry.label,
    validatedAt: isoSecond(entry.validatedAt),
    validatedById: entry.validatedById,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    sourceVersion: entry.sourceVersion,
    reversalOfId: entry.reversalOfId,
    closingEntry: entry.closingEntry,
    lines,
    prevHash,
  })
}

export function entryHash(entry: ChainEntry, prevHash: string): string {
  return sha256Hex(canonicalEntry(entry, prevHash))
}
