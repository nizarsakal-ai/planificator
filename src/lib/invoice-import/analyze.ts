// SPEC-INVOICE-IMPORT-001 §3 — analyse PURE d'un lot : rapprochement client, doublons, déjà importé, conflits, liens d'avoir.
// Recalculée à chaque lecture et juste avant la validation (dans la transaction) : l'aperçu ne fait jamais foi.
import { STATUS_LABEL } from "./format"
import { contentHash, nameKey, numberKey } from "./normalize"
import type { AnalyzedRow, Anomaly, BatchSummary, ClientCandidate, PreviewRow } from "./types"

export interface ExistingImported {
  id: string; kind: "INVOICE" | "CREDIT_NOTE"; number: string; numberKey: string; contentHash: string; fileId: string | null
  clientId: string; clientName: string; issueDate: string; dueDate: string | null; htCents: string; vatCents: string; ttcCents: string; status: string; creditedNumber: string | null
}
export interface AnalysisState {
  clients: ClientCandidate[]
  imported: ExistingImported[]
  /** Pièces émises par Planificator (collision de numéro, rattachement d'un avoir importé). */
  native: { id: string; number: string; kind: string }[]
  worksiteIds: ReadonlySet<string>
}

const euro = (cents: string | null): string => (cents === null ? "—" : `${(Number(cents) / 100).toFixed(2).replace(".", ",")} €`)

/** Rapprochement d'un nom de client : exact (clé normalisée) puis approché (inclusion). */
export function matchClient(name: string, clients: ClientCandidate[]): { exact: ClientCandidate[]; near: ClientCandidate[] } {
  const key = nameKey(name)
  if (!key) return { exact: [], near: [] }
  const exact = clients.filter((c) => nameKey(c.name) === key)
  if (exact.length) return { exact, near: [] }
  const near = key.length >= 4 ? clients.filter((c) => { const k = nameKey(c.name); return k.length >= 4 && (k.includes(key) || key.includes(k)) }) : []
  return { exact: [], near: near.slice(0, 10) }
}

export function rowContentHash(row: PreviewRow, clientId: string): string {
  return contentHash({
    kind: row.kind, numberKey: numberKey(row.number), clientId, issueDate: row.issueDate ?? "", dueDate: row.dueDate,
    htCents: row.htCents ?? "", vatCents: row.vatCents ?? "", ttcCents: row.ttcCents ?? "", status: row.status,
    creditedNumberKey: row.creditedNumber ? numberKey(row.creditedNumber) : null,
  })
}

function differences(row: PreviewRow, clientName: string, e: ExistingImported): { field: string; existing: string; incoming: string }[] {
  const d: { field: string; existing: string; incoming: string }[] = []
  const add = (field: string, existing: string, incoming: string) => { if (existing !== incoming) d.push({ field, existing, incoming }) }
  add("Client", e.clientName, clientName)
  add("Date", e.issueDate, row.issueDate ?? "—")
  add("Échéance", e.dueDate ?? "—", row.dueDate ?? "—")
  add("Montant HT", euro(e.htCents), euro(row.htCents))
  add("TVA", euro(e.vatCents), euro(row.vatCents))
  add("Montant TTC", euro(e.ttcCents), euro(row.ttcCents))
  add("Statut", STATUS_LABEL[e.status as keyof typeof STATUS_LABEL] ?? e.status, STATUS_LABEL[row.status])
  add("Facture d'origine", e.creditedNumber ?? "—", row.creditedNumber ?? "—")
  return d
}

export function analyzeBatch(rows: PreviewRow[], state: AnalysisState): AnalyzedRow[] {
  const clientById = new Map(state.clients.map((c) => [c.id, c]))
  const importedByKey = new Map(state.imported.map((e) => [`${e.kind}|${e.numberKey}`, e]))
  const nativeByKey = new Map(state.native.map((n) => [numberKey(n.number), n]))
  const active = rows.filter((r) => !r.excluded && r.kind !== "SUPPLIER")
  const countInBatch = new Map<string, number>()
  for (const r of active) { const k = numberKey(r.number); if (k) countInBatch.set(`${r.kind}|${k}`, (countInBatch.get(`${r.kind}|${k}`) ?? 0) + 1) }
  const batchInvoices = new Map(active.filter((r) => r.kind === "INVOICE" && numberKey(r.number)).map((r) => [numberKey(r.number), r]))

  return rows.map((row): AnalyzedRow => {
    const anomalies: Anomaly[] = []
    const push = (code: Anomaly["code"], blocking: boolean, message: string) => anomalies.push({ code, blocking, message })
    const base = { row, clientCandidates: [] as ClientCandidate[], conflict: null, credited: null, resolvedClientId: null as string | null }

    if (row.excluded) return { ...base, anomalies, outcome: "SKIP" }
    if (row.kind === "SUPPLIER") {
      push("SUPPLIER_DOCUMENT", false, "Facture fournisseur : elle n'est pas importée ici. Utilisez Comptabilité → Factures fournisseurs → « Scanner / importer une facture ».")
      return { ...base, anomalies, outcome: "REDIRECT" }
    }

    const key = numberKey(row.number)
    if (!key) push("NUMBER_MISSING", true, "Numéro de pièce manquant.")
    if (!row.issueDate) push("DATE_MISSING", true, "Date d'émission manquante ou illisible.")
    if (row.htCents === null || row.vatCents === null || row.ttcCents === null) push("AMOUNTS_MISSING", true, "Montants HT, TVA et TTC à compléter.")
    else {
      const ht = BigInt(row.htCents), vat = BigInt(row.vatCents), ttc = BigInt(row.ttcCents)
      if (ht < BigInt(0) || vat < BigInt(0) || ttc <= BigInt(0) || ht + vat !== ttc) push("AMOUNTS_INCONSISTENT", true, "Montants incohérents : HT + TVA doit être égal au TTC (valeurs positives, y compris pour un avoir).")
    }
    if (row.extractionNote) push("EXTRACTION_INCOMPLETE", false, row.extractionNote)
    if (!row.fileId) push("PDF_MISSING", false, row.expectedFileName ? `PDF manquant (${row.expectedFileName}).` : "PDF manquant.")
    if (row.worksiteId && !state.worksiteIds.has(row.worksiteId)) push("CLIENT_MISSING", true, "Chantier introuvable.")

    // Client : confirmé par l'utilisateur, sinon rapprochement exact et unique ; tout le reste demande une confirmation.
    let clientId: string | null = null
    let candidates: ClientCandidate[] = []
    if (row.clientId) {
      if (clientById.has(row.clientId)) clientId = row.clientId
      else push("CLIENT_MISSING", true, "Client sélectionné introuvable.")
    } else if (row.createClient) {
      if (!row.clientName.trim()) push("CLIENT_MISSING", true, "Nom du client à créer manquant.")
      else if (matchClient(row.clientName, state.clients).exact.length) push("CLIENT_AMBIGUOUS", true, "Un client porte déjà ce nom : sélectionnez-le au lieu d'en créer un nouveau.")
    } else {
      const m = matchClient(row.clientName, state.clients)
      candidates = m.exact.length ? m.exact : m.near
      if (m.exact.length === 1) clientId = m.exact[0].id
      else if (m.exact.length > 1) push("CLIENT_AMBIGUOUS", true, "Plusieurs clients portent ce nom : choisissez le bon.")
      else if (m.near.length) push("CLIENT_TO_CONFIRM", true, "Client approchant trouvé : confirmez le rapprochement ou créez le client.")
      else push("CLIENT_MISSING", true, row.clientName.trim() ? "Client inconnu : choisissez un client existant ou créez-le." : "Client à choisir.")
    }

    // Avoir : facture d'origine (pièce importée, pièce du lot, puis pièce Planificator).
    let credited: AnalyzedRow["credited"] = null
    if (row.kind === "CREDIT_NOTE" && row.creditedNumber) {
      const ck = numberKey(row.creditedNumber)
      const imp = importedByKey.get(`INVOICE|${ck}`), inBatch = batchInvoices.get(ck), nat = nativeByKey.get(ck)
      if (imp) credited = { type: "IMPORTED", id: imp.id, number: imp.number }
      else if (inBatch) credited = { type: "BATCH", id: inBatch.id, number: inBatch.number }
      else if (nat && nat.kind !== "CREDIT_NOTE") credited = { type: "NATIVE", id: nat.id, number: nat.number }
      else push("CREDITED_NOT_FOUND", false, `Facture d'origine ${row.creditedNumber} introuvable : la référence sera conservée sans lien.`)
    }

    let conflict: AnalyzedRow["conflict"] = null
    let identical = false
    if (key) {
      if ((countInBatch.get(`${row.kind}|${key}`) ?? 0) > 1) push("DUPLICATE_IN_BATCH", true, "Numéro présent plusieurs fois dans ce lot : excluez les lignes en trop.")
      const native = nativeByKey.get(key)
      if (native) push("NATIVE_NUMBER_COLLISION", true, `Le numéro ${native.number} est déjà celui d'une pièce émise dans Planificator : excluez cette ligne.`)
      const existing = importedByKey.get(`${row.kind}|${key}`)
      if (existing) {
        const sameClient = clientId ?? (row.createClient ? "" : existing.clientId)
        if (!anomalies.some((a) => a.blocking && a.code !== "CLIENT_MISSING" && a.code !== "CLIENT_TO_CONFIRM" && a.code !== "CLIENT_AMBIGUOUS") && rowContentHash(row, sameClient) === existing.contentHash) {
          // Même identité, même contenu : déjà importée. Le client de la pièce existante fait foi (aucune confirmation redemandée).
          identical = true
          for (let i = anomalies.length - 1; i >= 0; i--) if (anomalies[i].code.startsWith("CLIENT_")) anomalies.splice(i, 1)
          clientId = existing.clientId
          push("ALREADY_IMPORTED", false, row.fileId && !existing.fileId ? "Déjà importée à l'identique : seul le PDF manquant sera ajouté." : "Déjà importée à l'identique : ignorée.")
          conflict = { existingId: existing.id, differences: [] }
        } else {
          const name = clientId ? clientById.get(clientId)?.name ?? row.clientName : row.clientName
          conflict = { existingId: existing.id, differences: differences(row, name, existing) }
          push("CONFLICT", row.decision === null, row.decision === "KEEP" ? "Conflit : la pièce déjà importée est conservée, cette ligne est ignorée." : "Conflit avec une pièce déjà importée (jamais écrasée) : confirmez « Conserver l'existant » ou excluez la ligne.")
        }
      }
    }

    const existingFile = conflict ? state.imported.find((e) => e.id === conflict!.existingId)?.fileId ?? null : null
    let outcome: AnalyzedRow["outcome"]
    if (conflict && !identical && row.decision === "KEEP") outcome = "SKIP"
    else if (anomalies.some((a) => a.blocking)) outcome = "BLOCKED"
    else if (identical) outcome = row.fileId && !existingFile ? "ATTACH" : "SKIP"
    else outcome = "IMPORT"
    return { row, anomalies, outcome, clientCandidates: candidates, resolvedClientId: clientId, conflict, credited }
  })
}

export function summarize(analyzed: AnalyzedRow[]): BatchSummary {
  const n = (o: AnalyzedRow["outcome"]) => analyzed.filter((a) => a.outcome === o).length
  return { total: analyzed.length, toImport: n("IMPORT"), toAttach: n("ATTACH"), skipped: n("SKIP"), blocked: n("BLOCKED"), supplier: n("REDIRECT") }
}
