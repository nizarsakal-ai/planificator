// ═══════════════════════════════════════════════════════════════════════════
// SPEC-INVOICE-IMPORT-001 — service d'import des factures clients et avoirs (autorité métier ; actions = enveloppes fines).
// Contexte = requireBillingAdmin + drapeau INVOICE_IMPORT_ENABLED ; `companyId` toujours issu de la session.
// Garanties : aucune écriture dans `invoices`, `invoice_payments`, `document_counters`, `billing_mail_logs`, journaux comptables
// ni `supplier_invoices`. Une pièce déjà importée n'est jamais modifiée (seul un PDF manquant peut être ajouté à une pièce identique).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash, randomUUID } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { LifecycleAbort, withLifecycleAbort } from "@/lib/billing/lifecycle-abort"
import { MAX_OCR_FILE_BYTES, sniffMime } from "@/lib/accounting/c5/ocr-provider"
import { analyzeBatch, rowContentHash, summarize, type AnalysisState, type ExistingImported } from "./analyze"
import { nameKey, numberKey } from "./normalize"
import { extractDocument, type ExtractedDocument, type OwnCompany } from "./pdf-extract"
import { TabularError, guessMapping, headerLabels, headerSignature, readTable, tableToPreviewRows, validateMapping, type Cell } from "./tabular"
import { ZipError, isZip, readZip } from "./zip"
import type { AnalyzedRow, BatchSummary, ColumnMapping, ImportRowKind, ImportSourceSystem, ImportStatus, PreviewRow } from "./types"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface ImportContext { companyId: string; userId: string }

export const MAX_BATCH_ROWS = 2000
export const MAX_BATCH_FILES = 500
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export const IMPORT_ERRORS = {
  notFound: "Import introuvable.",
  closed: "Cet import est déjà validé ou annulé.",
  stale: "L'import a été modifié entretemps : rechargez la page.",
  empty: "Fichier vide.",
  tooLarge: "Fichier trop volumineux.",
  unsupported: "Format non pris en charge : PDF, JPEG, PNG, CSV, XLSX ou ZIP.",
  oneTable: "Un seul fichier de données (CSV ou Excel) par import : créez un nouvel import pour un autre export.",
  tooManyRows: `Trop de lignes dans cet import (maximum ${MAX_BATCH_ROWS}).`,
  tooManyFiles: `Trop de pièces dans cet import (maximum ${MAX_BATCH_FILES}).`,
  blocked: "Des lignes demandent encore une correction ou une confirmation.",
  nothing: "Aucune pièce à importer dans ce lot.",
  concurrent: "Une pièce de ce lot vient d'être importée par un autre utilisateur : rechargez l'aperçu.",
} as const

type JsonCell = string | number | null
interface StoredTable { file: string; cells: JsonCell[][] }
/** Contenu de `invoice_import_batches.rows` : lignes d'aperçu + tableau source (pour ré-associer les colonnes). */
interface BatchDocument { rows: PreviewRow[]; table: StoredTable | null }

const emptyDoc = (): BatchDocument => ({ rows: [], table: null })
function readDoc(raw: Prisma.JsonValue): BatchDocument {
  const d = raw as unknown as Partial<BatchDocument> | null
  return { rows: Array.isArray(d?.rows) ? (d.rows as PreviewRow[]) : [], table: d?.table ?? null }
}
const toJson = (doc: BatchDocument): Prisma.InputJsonValue => doc as unknown as Prisma.InputJsonValue
const jsonCell = (c: Cell): JsonCell => (c instanceof Date ? (Number.isNaN(c.getTime()) ? null : c.toISOString().slice(0, 10)) : c)

export async function createBatch(db: Db, ctx: ImportContext, input: { sourceSystem: ImportSourceSystem; sourceLabel: string | null }): Promise<{ id: string }> {
  return db.invoiceImportBatch.create({
    data: { companyId: ctx.companyId, sourceSystem: input.sourceSystem, sourceLabel: input.sourceSystem === "OTHER" ? input.sourceLabel?.trim().slice(0, 80) || null : null, rows: toJson(emptyDoc()), createdById: ctx.userId },
    select: { id: true },
  })
}

async function loadPreviewBatch(db: Db | Tx, ctx: ImportContext, batchId: string) {
  const batch = await db.invoiceImportBatch.findFirst({ where: { id: batchId, companyId: ctx.companyId } })
  if (!batch) return { ok: false as const, error: IMPORT_ERRORS.notFound }
  if (batch.status !== "PREVIEW") return { ok: false as const, error: IMPORT_ERRORS.closed }
  return { ok: true as const, batch, doc: readDoc(batch.rows) }
}

/** Écriture du lot sous verrou optimiste : un écrivain concurrent fait échouer l'autre (jamais de fusion silencieuse). */
async function saveDoc(db: Db | Tx, ctx: ImportContext, batchId: string, version: number, doc: BatchDocument, extra: Prisma.InvoiceImportBatchUpdateManyMutationInput = {}): Promise<boolean> {
  const r = await db.invoiceImportBatch.updateMany({ where: { id: batchId, companyId: ctx.companyId, status: "PREVIEW", version }, data: { ...extra, rows: toJson(doc), version: { increment: 1 } } })
  return r.count === 1
}

/** Stocke une pièce (type par signature binaire, taille, empreinte) ; même empreinte dans la société ⇒ pièce existante réutilisée. */
async function storeFile(db: Db, ctx: ImportContext, data: Buffer, name: string): Promise<LifecycleResult<{ id: string; mime: string }>> {
  if (data.length === 0) return { ok: false, error: IMPORT_ERRORS.empty }
  if (data.length > MAX_OCR_FILE_BYTES) return { ok: false, error: `« ${name} » dépasse 10 Mo.` }
  const mime = sniffMime(data)
  if (!mime) return { ok: false, error: `« ${name} » : type de fichier refusé.` }
  const sha256 = createHash("sha256").update(data).digest("hex")
  const where = { companyId_sha256: { companyId: ctx.companyId, sha256 } }
  const existing = await db.importedDocumentFile.findUnique({ where, select: { id: true } })
  if (existing) return { ok: true, value: { id: existing.id, mime } }
  try {
    const f = await db.importedDocumentFile.create({ data: { companyId: ctx.companyId, sha256, mime, size: data.length, data, originalName: name.slice(0, 200) }, select: { id: true } })
    return { ok: true, value: { id: f.id, mime } }
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e
    const winner = await db.importedDocumentFile.findUnique({ where, select: { id: true } })
    if (!winner) throw e
    return { ok: true, value: { id: winner.id, mime } }
  }
}

const baseName = (n: string): string => (n.replace(/\\/g, "/").split("/").pop() ?? n).trim()
const stem = (n: string): string => baseName(n).replace(/\.[A-Za-z0-9]{1,5}$/, "")

/** Ligne du tableau à laquelle rattacher un PDF : nom de fichier attendu, sinon numéro de pièce contenu dans le nom du PDF. */
function findRowForFile(rows: PreviewRow[], fileName: string): PreviewRow | null {
  const free = rows.filter((r) => r.origin.type === "table" && !r.fileId)
  const lower = baseName(fileName).toLowerCase()
  const byName = free.filter((r) => r.expectedFileName && (r.expectedFileName.toLowerCase() === lower || stem(r.expectedFileName).toLowerCase() === stem(fileName).toLowerCase()))
  if (byName.length === 1) return byName[0]
  const key = numberKey(stem(fileName))
  // Numéro complet présent dans le nom du fichier ; le plus long l'emporte, et il doit être unique (« F-12 » ne capte pas « F-123.pdf »).
  const byNumber = free.filter((r) => { const k = numberKey(r.number); return k.length >= 3 && key.includes(k) }).sort((a, b) => numberKey(b.number).length - numberKey(a.number).length)
  if (byNumber.length === 0) return null
  const best = numberKey(byNumber[0].number).length
  return byNumber.filter((r) => numberKey(r.number).length === best).length === 1 ? byNumber[0] : null
}

function rowFromExtraction(x: ExtractedDocument, fileName: string, fileId: string, clientHint: string): PreviewRow {
  const kind: ImportRowKind = x.kind ?? "INVOICE"
  return {
    id: randomUUID(), origin: { type: "pdf", file: fileName.slice(0, 200) }, kind, number: x.number ?? "", clientName: clientHint, clientId: null, createClient: false, worksiteId: null,
    issueDate: x.issueDate, dueDate: x.dueDate, htCents: x.htCents?.toString() ?? null, vatCents: x.vatCents?.toString() ?? null, ttcCents: x.ttcCents?.toString() ?? null,
    sourceStatus: null, status: "UNKNOWN" as ImportStatus, sourceReference: null, creditedNumber: x.creditedNumber, fileId, fileName: baseName(fileName).slice(0, 200), expectedFileName: null,
    decision: null, excluded: false, extractionNote: x.note,
  }
}

/** Client dont le nom figure dans le texte du PDF — retenu seulement s'il est unique (sinon l'utilisateur choisit). */
function clientHintFromText(text: string, clients: { name: string }[], own: OwnCompany): string {
  const hay = ` ${nameKey(text)} `
  const ownKey = nameKey(own.name)
  const hits = clients.filter((c) => { const k = nameKey(c.name); return k.length >= 4 && k !== ownKey && hay.includes(` ${k} `) })
  return hits.length === 1 ? hits[0].name : ""
}

export interface AddFileResult { added: number; attached: number; tables: number; warnings: string[] }
export interface AddFileDeps { extract?: typeof extractDocument }

/**
 * Ajoute un fichier au lot : ZIP (données + PDF), CSV/XLSX (un seul par lot), PDF ou image (scan).
 * Les lectures lourdes (ZIP, PDF, OCR) se font HORS transaction ; l'écriture finale est une mise à jour sous verrou optimiste.
 */
export async function addFileToBatch(db: Db, ctx: ImportContext, batchId: string, file: { name: string; data: Buffer }, deps: AddFileDeps = {}): Promise<LifecycleResult<AddFileResult>> {
  const loaded = await loadPreviewBatch(db, ctx, batchId)
  if (!loaded.ok) return loaded
  const { batch, doc } = loaded
  if (file.data.length === 0) return { ok: false, error: IMPORT_ERRORS.empty }
  if (file.data.length > MAX_UPLOAD_BYTES) return { ok: false, error: IMPORT_ERRORS.tooLarge }

  const isXlsx = /\.xlsx$/i.test(file.name)
  let entries: { name: string; data: Buffer }[]
  if (isZip(file.data) && !isXlsx) {
    try { entries = readZip(file.data) } catch (e) { if (e instanceof ZipError) return { ok: false, error: e.message }; throw e }
    if (entries.length === 0) return { ok: false, error: "Archive vide." }
  } else entries = [{ name: baseName(file.name), data: file.data }]

  const tables = entries.filter((e) => /\.(csv|txt|xlsx|xls)$/i.test(e.name))
  const documents = entries.filter((e) => !tables.includes(e))
  if (tables.length > 1 || (tables.length === 1 && doc.table)) return { ok: false, error: IMPORT_ERRORS.oneTable }

  const result: AddFileResult = { added: 0, attached: 0, tables: 0, warnings: [] }
  let mapping = batch.mapping as ColumnMapping | null
  let signature = batch.headerSignature

  // 1. Tableau de données : association mémorisée pour ce logiciel et ces en-têtes, sinon devinée (toujours modifiable).
  if (tables.length === 1) {
    let cells: JsonCell[][]
    try { cells = (await readTable(tables[0].data, tables[0].name)).rows.map((r) => r.map(jsonCell)) } catch (e) { if (e instanceof TabularError) return { ok: false, error: e.message }; throw e }
    const guessed = guessMapping(cells)
    signature = headerSignature(cells, guessed.headerRows)
    const remembered = await db.invoiceImportBatch.findFirst({
      where: { companyId: ctx.companyId, sourceSystem: batch.sourceSystem, sourceLabel: batch.sourceLabel, headerSignature: signature, status: "COMMITTED", NOT: { mapping: { equals: Prisma.DbNull } } },
      orderBy: { committedAt: "desc" }, select: { mapping: true },
    })
    const width = cells.reduce((m, r) => Math.max(m, r.length), 0)
    const candidate = remembered?.mapping as ColumnMapping | undefined
    mapping = candidate && validateMapping(candidate, width) === null ? candidate : guessed
    doc.table = { file: tables[0].name, cells }
    const rows = mapping.number === undefined ? [] : tableToPreviewRows({ rows: cells, sheetName: null }, mapping, tables[0].name, randomUUID)
    if (mapping.number === undefined) result.warnings.push("Colonne du numéro de pièce non reconnue : associez les colonnes pour afficher les lignes.")
    // Un PDF déjà déposé pour la même pièce est rattaché à la ligne du tableau (qui fait foi) et sa ligne propre disparaît.
    for (const r of rows) {
      const k = numberKey(r.number)
      const twin = k ? doc.rows.find((p) => p.origin.type === "pdf" && p.kind !== "SUPPLIER" && numberKey(p.number) === k && p.fileId) : undefined
      if (twin) { r.fileId = twin.fileId; r.fileName = twin.fileName; doc.rows = doc.rows.filter((p) => p !== twin); result.attached++ }
    }
    doc.rows = [...rows, ...doc.rows]
    result.tables = 1; result.added += rows.length
  }

  // 2. Pièces : rattachement par nom, sinon extraction (texte puis OCR existant) et nouvelle ligne.
  if (documents.length) {
    const [company, clients] = await Promise.all([
      db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true, siret: true } }),
      db.client.findMany({ where: { companyId: ctx.companyId }, select: { name: true } }),
    ])
    const extract = deps.extract ?? extractDocument
    const knownFiles = new Set(doc.rows.map((r) => r.fileId).filter(Boolean))
    for (const d of documents) {
      if (doc.rows.filter((r) => r.fileId).length >= MAX_BATCH_FILES) { result.warnings.push(IMPORT_ERRORS.tooManyFiles); break }
      const stored = await storeFile(db, ctx, d.data, d.name)
      if (!stored.ok) { result.warnings.push(stored.error); continue }
      if (knownFiles.has(stored.value.id)) { result.warnings.push(`« ${d.name} » est déjà dans cet import.`); continue }
      knownFiles.add(stored.value.id)
      const target = findRowForFile(doc.rows, d.name)
      if (target) { target.fileId = stored.value.id; target.fileName = baseName(d.name).slice(0, 200); result.attached++; continue }
      const x = await extract({ data: d.data, mime: stored.value.mime }, company)
      const k = x.number ? numberKey(x.number) : ""
      const byNumber = k && x.kind !== "SUPPLIER" ? doc.rows.filter((r) => r.origin.type === "table" && !r.fileId && numberKey(r.number) === k) : []
      if (byNumber.length === 1) { byNumber[0].fileId = stored.value.id; byNumber[0].fileName = baseName(d.name).slice(0, 200); result.attached++; continue }
      doc.rows.push(rowFromExtraction(x, d.name, stored.value.id, x.text ? clientHintFromText(x.text, clients, company) : ""))
      result.added++
    }
  }

  if (doc.rows.length > MAX_BATCH_ROWS) return { ok: false, error: IMPORT_ERRORS.tooManyRows }
  if (!(await saveDoc(db, ctx, batchId, batch.version, doc, { mapping: mapping ? (mapping as unknown as Prisma.InputJsonValue) : undefined, headerSignature: signature }))) return { ok: false, error: IMPORT_ERRORS.stale }
  return { ok: true, value: result }
}

/** Ré-associe les colonnes : les lignes issues du tableau sont régénérées (PDF déjà rattachés conservés), les lignes PDF intactes. */
export async function updateBatchMapping(db: Db, ctx: ImportContext, batchId: string, version: number, mapping: ColumnMapping): Promise<LifecycleResult> {
  const loaded = await loadPreviewBatch(db, ctx, batchId)
  if (!loaded.ok) return loaded
  const { doc } = loaded
  if (!doc.table) return { ok: false, error: "Cet import ne contient pas de fichier de données." }
  const width = doc.table.cells.reduce((m, r) => Math.max(m, r.length), 0)
  const invalid = validateMapping(mapping, width)
  if (invalid) return { ok: false, error: invalid }
  const previous = doc.rows.filter((r) => r.origin.type === "table")
  const rows = tableToPreviewRows({ rows: doc.table.cells, sheetName: null }, mapping, doc.table.file, randomUUID)
  const files = previous.filter((r) => r.fileId).map((r) => ({ fileId: r.fileId as string, fileName: r.fileName ?? "" }))
  const orphans: PreviewRow[] = []
  for (const f of files) {
    const target = findRowForFile(rows, f.fileName)
    if (target) { target.fileId = f.fileId; target.fileName = f.fileName }
    else orphans.push({ ...rowFromExtraction({ kind: null, number: null, issueDate: null, dueDate: null, htCents: null, vatCents: null, ttcCents: null, issuerName: null, issuerSiret: null, creditedNumber: null, text: "", method: "NONE", note: "PDF non rattaché après la nouvelle association des colonnes : complétez ou excluez." }, f.fileName, f.fileId, "") })
  }
  doc.rows = [...rows, ...doc.rows.filter((r) => r.origin.type === "pdf"), ...orphans]
  if (doc.rows.length > MAX_BATCH_ROWS) return { ok: false, error: IMPORT_ERRORS.tooManyRows }
  return (await saveDoc(db, ctx, batchId, version, doc, { mapping: mapping as unknown as Prisma.InputJsonValue, headerSignature: headerSignature(doc.table.cells, mapping.headerRows) })) ? { ok: true, value: undefined } : { ok: false, error: IMPORT_ERRORS.stale }
}

export interface RowPatch {
  id: string
  kind?: ImportRowKind; number?: string; clientName?: string; clientId?: string | null; createClient?: boolean; worksiteId?: string | null
  issueDate?: string | null; dueDate?: string | null; htCents?: string | null; vatCents?: string | null; ttcCents?: string | null
  status?: ImportStatus; creditedNumber?: string | null; decision?: "KEEP" | null; excluded?: boolean
}

/** Applique les corrections de l'aperçu. Les identifiants (client, chantier) sont revérifiés dans la société à l'analyse et à la validation. */
export async function updateBatchRows(db: Db, ctx: ImportContext, batchId: string, version: number, patches: RowPatch[]): Promise<LifecycleResult> {
  const loaded = await loadPreviewBatch(db, ctx, batchId)
  if (!loaded.ok) return loaded
  const { doc } = loaded
  const byId = new Map(doc.rows.map((r) => [r.id, r]))
  for (const p of patches) {
    const row = byId.get(p.id)
    if (!row) return { ok: false, error: "Ligne introuvable dans cet import." }
    const { id: _id, ...fields } = p
    void _id
    Object.assign(row, fields)
    if (p.clientId) row.createClient = false
    if (p.createClient) row.clientId = null
    if (row.kind !== "CREDIT_NOTE") row.creditedNumber = null
  }
  return (await saveDoc(db, ctx, batchId, version, doc)) ? { ok: true, value: undefined } : { ok: false, error: IMPORT_ERRORS.stale }
}

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

async function loadState(db: Db | Tx, ctx: ImportContext, rows: PreviewRow[]): Promise<AnalysisState> {
  const keys = [...new Set(rows.flatMap((r) => [numberKey(r.number), r.creditedNumber ? numberKey(r.creditedNumber) : ""]).filter(Boolean))]
  const worksiteIds = [...new Set(rows.map((r) => r.worksiteId).filter((w): w is string => !!w))]
  const [clients, imported, native, worksites] = await Promise.all([
    db.client.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    keys.length ? db.importedInvoice.findMany({ where: { companyId: ctx.companyId, numberKey: { in: keys } }, include: { client: { select: { name: true } } } }) : Promise.resolve([]),
    // Les numéros Planificator sont comparés par clé normalisée : la société n'a que quelques milliers de pièces au plus.
    db.invoice.findMany({ where: { companyId: ctx.companyId }, select: { id: true, number: true, kind: true } }),
    worksiteIds.length ? db.worksite.findMany({ where: { companyId: ctx.companyId, id: { in: worksiteIds } }, select: { id: true } }) : Promise.resolve([]),
  ])
  const wanted = new Set(keys)
  return {
    clients,
    imported: imported.map((e): ExistingImported => ({
      id: e.id, kind: e.kind, number: e.number, numberKey: e.numberKey, contentHash: e.contentHash, fileId: e.fileId, clientId: e.clientId, clientName: e.client.name,
      issueDate: day(e.issueDate) as string, dueDate: day(e.dueDate), htCents: e.totalHTCents.toString(), vatCents: e.vatCents.toString(), ttcCents: e.totalTTCCents.toString(), status: e.status, creditedNumber: e.creditedNumber,
    })),
    native: native.filter((n) => wanted.has(numberKey(n.number))),
    worksiteIds: new Set(worksites.map((w) => w.id)),
  }
}

export interface BatchView {
  id: string; status: string; sourceSystem: string; sourceLabel: string | null; version: number; createdAt: Date; committedAt: Date | null
  analyzed: AnalyzedRow[]; summary: BatchSummary
  table: { file: string; headers: string[]; sample: JsonCell[][]; mapping: ColumnMapping } | null
}

export async function getBatchView(db: Db, ctx: ImportContext, batchId: string): Promise<BatchView | null> {
  const batch = await db.invoiceImportBatch.findFirst({ where: { id: batchId, companyId: ctx.companyId } })
  if (!batch) return null
  const doc = readDoc(batch.rows)
  // Lot clos : l'aperçu est figé (résumé enregistré) ; lot ouvert : analyse recalculée sur l'état courant de la base.
  const analyzed = batch.status === "PREVIEW" ? analyzeBatch(doc.rows, await loadState(db, ctx, doc.rows)) : []
  const mapping = batch.mapping as ColumnMapping | null
  return {
    id: batch.id, status: batch.status, sourceSystem: batch.sourceSystem, sourceLabel: batch.sourceLabel, version: batch.version, createdAt: batch.createdAt, committedAt: batch.committedAt,
    analyzed, summary: batch.status === "PREVIEW" ? summarize(analyzed) : ((batch.summary as unknown as BatchSummary | null) ?? summarize([])),
    table: doc.table && mapping && batch.status === "PREVIEW" ? { file: doc.table.file, headers: headerLabels(doc.table.cells, mapping.headerRows), sample: doc.table.cells.slice(mapping.headerRows, mapping.headerRows + 3), mapping } : null,
  }
}

const utcDay = (s: string): Date => new Date(`${s}T00:00:00Z`)

/**
 * Validation : transaction unique, tout ou rien. Le lot passe PREVIEW → COMMITTED sous verrou optimiste AVANT toute écriture
 * (deux validations simultanées : une seule gagne), l'analyse est refaite dans la transaction, puis les pièces sont créées.
 */
export async function commitBatch(db: Db, ctx: ImportContext, batchId: string, version: number): Promise<LifecycleResult<BatchSummary>> {
  return withLifecycleAbort(async () => {
    try {
      return await db.$transaction(async (tx) => {
        const loaded = await loadPreviewBatch(tx, ctx, batchId)
        if (!loaded.ok) return loaded
        const { batch, doc } = loaded
        const claimed = await tx.invoiceImportBatch.updateMany({ where: { id: batchId, companyId: ctx.companyId, status: "PREVIEW", version }, data: { status: "COMMITTED", committedAt: new Date(), committedById: ctx.userId, version: { increment: 1 } } })
        if (claimed.count !== 1) return { ok: false as const, error: IMPORT_ERRORS.stale }

        const analyzed = analyzeBatch(doc.rows, await loadState(tx, ctx, doc.rows))
        const summary = summarize(analyzed)
        if (summary.blocked > 0) throw new LifecycleAbort(IMPORT_ERRORS.blocked)
        if (summary.toImport + summary.toAttach === 0) throw new LifecycleAbort(IMPORT_ERRORS.nothing)

        // Pièces jointes : revérifiées dans la société (un identifiant de fichier ne vient jamais du navigateur sans contrôle).
        const fileIds = [...new Set(analyzed.filter((a) => a.outcome === "IMPORT" || a.outcome === "ATTACH").map((a) => a.row.fileId).filter((f): f is string => !!f))]
        const files = fileIds.length ? await tx.importedDocumentFile.findMany({ where: { companyId: ctx.companyId, id: { in: fileIds } }, select: { id: true } }) : []
        if (files.length !== fileIds.length) throw new LifecycleAbort("Une pièce jointe de cet import est introuvable.")

        // Clients créés sur choix explicite uniquement ; un même nom dans le lot ne crée qu'un client.
        const created = new Map<string, string>()
        const clientIdOf = async (a: AnalyzedRow): Promise<string> => {
          if (a.resolvedClientId) return a.resolvedClientId
          if (!a.row.createClient) throw new LifecycleAbort(IMPORT_ERRORS.blocked)
          const key = nameKey(a.row.clientName)
          const known = created.get(key)
          if (known) return known
          const c = await tx.client.create({ data: { companyId: ctx.companyId, name: a.row.clientName.trim().slice(0, 200), notes: `Créé par l'import de factures (${batch.sourceLabel ?? batch.sourceSystem}).` }, select: { id: true } })
          created.set(key, c.id)
          return c.id
        }

        const batchRowToInvoiceId = new Map<string, string>()
        const toImport = analyzed.filter((a) => a.outcome === "IMPORT")
        // Factures d'abord : un avoir du même lot peut alors référencer sa facture d'origine.
        for (const a of [...toImport.filter((x) => x.row.kind === "INVOICE"), ...toImport.filter((x) => x.row.kind === "CREDIT_NOTE")]) {
          const r = a.row
          const clientId = await clientIdOf(a)
          const creditedImportedInvoiceId = a.credited?.type === "IMPORTED" ? a.credited.id : a.credited?.type === "BATCH" ? batchRowToInvoiceId.get(a.credited.id) ?? null : null
          const inv = await tx.importedInvoice.create({
            data: {
              companyId: ctx.companyId, batchId, kind: r.kind as "INVOICE" | "CREDIT_NOTE", sourceSystem: batch.sourceLabel ?? batch.sourceSystem, sourceReference: r.sourceReference, sourceStatus: r.sourceStatus, status: r.status,
              number: r.number.trim().slice(0, 64), numberKey: numberKey(r.number), clientId, worksiteId: r.worksiteId,
              issueDate: utcDay(r.issueDate as string), dueDate: r.dueDate ? utcDay(r.dueDate) : null,
              totalHTCents: BigInt(r.htCents as string), vatCents: BigInt(r.vatCents as string), totalTTCCents: BigInt(r.ttcCents as string),
              creditedNumber: r.kind === "CREDIT_NOTE" ? r.creditedNumber : null, creditedImportedInvoiceId, creditedInvoiceId: a.credited?.type === "NATIVE" ? a.credited.id : null,
              fileId: r.fileId, contentHash: rowContentHash(r, clientId), createdById: ctx.userId,
            },
            select: { id: true },
          })
          batchRowToInvoiceId.set(r.id, inv.id)
        }
        // Pièce identique déjà importée sans PDF : seul le PDF manquant est ajouté (aucune autre donnée modifiée).
        for (const a of analyzed.filter((x) => x.outcome === "ATTACH")) {
          await tx.importedInvoice.updateMany({ where: { id: a.conflict?.existingId, companyId: ctx.companyId, fileId: null }, data: { fileId: a.row.fileId, updatedById: ctx.userId } })
        }

        await tx.invoiceImportBatch.update({ where: { id: batchId }, data: { summary: summary as unknown as Prisma.InputJsonValue } })
        await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "InvoiceImportBatch", entityId: batchId, detail: `Import de factures (${batch.sourceLabel ?? batch.sourceSystem}) : ${summary.toImport} pièce(s) importée(s), ${summary.toAttach} PDF ajouté(s), ${summary.skipped} ignorée(s)` } })
        return { ok: true as const, value: summary }
      }, { timeout: 60_000, maxWait: 10_000 })
    } catch (e) {
      // Course avec un autre import : l'unicité (société, nature, numéro) arbitre ; rien n'est écrit, l'utilisateur recharge l'aperçu.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: IMPORT_ERRORS.concurrent }
      throw e
    }
  })
}

/** Annule un lot en aperçu et supprime ses pièces restées sans facture (non partagées avec un autre lot en cours). */
export async function cancelBatch(db: Db, ctx: ImportContext, batchId: string): Promise<LifecycleResult> {
  const loaded = await loadPreviewBatch(db, ctx, batchId)
  if (!loaded.ok) return loaded
  const mine = new Set(loaded.doc.rows.map((r) => r.fileId).filter((f): f is string => !!f))
  const r = await db.invoiceImportBatch.updateMany({ where: { id: batchId, companyId: ctx.companyId, status: "PREVIEW" }, data: { status: "CANCELLED", rows: toJson(emptyDoc()), version: { increment: 1 } } })
  if (r.count !== 1) return { ok: false, error: IMPORT_ERRORS.closed }
  if (mine.size) {
    const others = await db.invoiceImportBatch.findMany({ where: { companyId: ctx.companyId, status: "PREVIEW" }, select: { rows: true } })
    for (const o of others) for (const row of readDoc(o.rows).rows) if (row.fileId) mine.delete(row.fileId)
    if (mine.size) await db.importedDocumentFile.deleteMany({ where: { companyId: ctx.companyId, id: { in: [...mine] }, invoices: { none: {} } } })
  }
  return { ok: true, value: undefined }
}

export interface ImportedInvoiceListItem {
  id: string; kind: "INVOICE" | "CREDIT_NOTE"; number: string; clientId: string; clientName: string; worksiteName: string | null; issueDate: Date; dueDate: Date | null
  totalHTCents: bigint; vatCents: bigint; totalTTCCents: bigint; status: ImportStatus; sourceStatus: string | null; sourceSystem: string; sourceReference: string | null
  hasFile: boolean; creditedNumber: string | null; credited: { href: string | null; number: string } | null
}

export async function listImportedInvoices(db: Db, companyId: string, f: { clientId?: string; q?: string; page?: number }): Promise<{ rows: ImportedInvoiceListItem[]; total: number; page: number; pageSize: number }> {
  const pageSize = 50
  const page = Math.max(1, Math.floor(f.page ?? 1))
  const q = f.q?.trim().slice(0, 80)
  const where: Prisma.ImportedInvoiceWhereInput = {
    companyId, ...(f.clientId ? { clientId: f.clientId } : {}),
    ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { client: { name: { contains: q, mode: "insensitive" } } }] } : {}),
  }
  const [total, rows] = await Promise.all([
    db.importedInvoice.count({ where }),
    db.importedInvoice.findMany({
      where, orderBy: [{ issueDate: "desc" }, { number: "desc" }], skip: (page - 1) * pageSize, take: pageSize,
      include: { client: { select: { name: true } }, worksite: { select: { name: true } }, creditedImportedInvoice: { select: { number: true } }, creditedInvoice: { select: { id: true, number: true } } },
    }),
  ])
  return {
    total, page, pageSize,
    rows: rows.map((r) => ({
      id: r.id, kind: r.kind, number: r.number, clientId: r.clientId, clientName: r.client.name, worksiteName: r.worksite?.name ?? null, issueDate: r.issueDate, dueDate: r.dueDate,
      totalHTCents: r.totalHTCents, vatCents: r.vatCents, totalTTCCents: r.totalTTCCents, status: r.status, sourceStatus: r.sourceStatus, sourceSystem: r.sourceSystem, sourceReference: r.sourceReference,
      hasFile: r.fileId !== null, creditedNumber: r.creditedNumber,
      credited: r.creditedInvoice ? { href: `/factures/${r.creditedInvoice.id}`, number: r.creditedInvoice.number } : r.creditedImportedInvoice ? { href: null, number: r.creditedImportedInvoice.number } : null,
    })),
  }
}

/** Pièce d'une facture importée, ou d'une ligne d'un lot en aperçu — toujours bornée à la société de session. */
export async function getImportedFile(db: Db, companyId: string, ref: { invoiceId: string } | { batchId: string; fileId: string }): Promise<{ data: Buffer; mime: string; originalName: string } | null> {
  let fileId: string | null
  if ("invoiceId" in ref) fileId = (await db.importedInvoice.findFirst({ where: { id: ref.invoiceId, companyId }, select: { fileId: true } }))?.fileId ?? null
  else {
    const batch = await db.invoiceImportBatch.findFirst({ where: { id: ref.batchId, companyId, status: "PREVIEW" }, select: { rows: true } })
    fileId = batch && readDoc(batch.rows).rows.some((r) => r.fileId === ref.fileId) ? ref.fileId : null
  }
  if (!fileId) return null
  const f = await db.importedDocumentFile.findFirst({ where: { id: fileId, companyId }, select: { data: true, mime: true, originalName: true } })
  return f ? { data: Buffer.from(f.data), mime: f.mime, originalName: f.originalName } : null
}
