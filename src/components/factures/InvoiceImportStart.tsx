"use client"
// Dépôt des fichiers d'un import (SPEC-INVOICE-IMPORT-001) : crée le lot puis envoie les fichiers un par un (limite d'une requête).
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { addInvoiceImportFileAction, createInvoiceImportAction } from "@/lib/actions/invoice-import.actions"

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.csv,.txt,.xlsx,.zip"
// La plateforme d'hébergement limite la taille d'une requête : au-delà, déposer les PDF séparément plutôt qu'en ZIP.
const MAX_FILE_BYTES = 4 * 1024 * 1024
type Source = "TIIME" | "OTHER" | "PDF"

export function InvoiceImportStart({ batchId }: { batchId?: string }) {
  const router = useRouter()
  const [source, setSource] = useState<Source>("TIIME")
  const [label, setLabel] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [progress, setProgress] = useState<string | null>(null)

  async function submit() {
    const tooBig = files.find((f) => f.size > MAX_FILE_BYTES)
    if (tooBig) { toast.error(`« ${tooBig.name} » dépasse 4 Mo : déposez les PDF un par un plutôt qu’en archive.`); return }
    if (files.length === 0) { toast.error("Choisissez au moins un fichier."); return }
    setProgress("Préparation…")
    try {
      let id = batchId
      if (!id) {
        const created = await createInvoiceImportAction({ sourceSystem: source, sourceLabel: source === "OTHER" ? label.trim() || null : null })
        if (!created.ok) { toast.error(created.error); return }
        id = created.id
      }
      // Données (CSV/Excel/ZIP) d'abord : les PDF déposés ensuite se rattachent aux lignes par leur nom.
      const ordered = [...files].sort((a, b) => Number(/\.(pdf|jpe?g|png|webp)$/i.test(a.name)) - Number(/\.(pdf|jpe?g|png|webp)$/i.test(b.name)))
      let failures = 0
      for (const [i, file] of ordered.entries()) {
        setProgress(`Analyse ${i + 1} / ${ordered.length} : ${file.name}`)
        const fd = new FormData(); fd.set("batchId", id); fd.set("file", file)
        const r = await addInvoiceImportFileAction(fd)
        if (!r.ok) { failures++; toast.error(`${file.name} : ${r.error}`) } else r.warnings.forEach((w) => toast.warning(w))
      }
      if (failures === ordered.length && !batchId) toast.error("Aucun fichier n’a pu être lu.")
      setFiles([])
      if (batchId) router.refresh(); else router.push(`/factures/import/${id}`)
    } catch { toast.error("Envoi impossible. Vérifiez la taille des fichiers et réessayez.") } finally { setProgress(null) }
  }

  return (
    <Card><CardContent className="space-y-4 p-4">
      {!batchId && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Logiciel d’origine</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {([["TIIME", "Tiime"], ["OTHER", "Autre logiciel"], ["PDF", "PDF seuls (sans export)"]] as const).map(([v, l]) => (
              <label key={v} className="flex items-center gap-2"><input type="radio" name="source" value={v} checked={source === v} onChange={() => setSource(v)} /> {l}</label>
            ))}
          </div>
          {source === "OTHER" && <div className="max-w-xs"><Label htmlFor="import-source-label">Nom du logiciel</Label><Input id="import-source-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Ex. Pennylane, Sage…" autoComplete="off" /></div>}
        </fieldset>
      )}
      <div>
        <Label htmlFor="import-files">{batchId ? "Ajouter des fichiers à cet import" : "Fichiers"}</Label>
        <Input id="import-files" type="file" multiple accept={ACCEPT} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        <p className="mt-1 text-xs text-slate-500">PDF ou scans (JPEG, PNG), export CSV ou Excel (.xlsx), ou ZIP contenant l’export et les PDF. 4 Mo par fichier ; plusieurs fichiers possibles.</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={submit} disabled={progress !== null || files.length === 0}>{progress !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {batchId ? "Ajouter" : "Analyser"}</Button>
        <span className="text-sm text-slate-500" aria-live="polite">{progress}</span>
      </div>
    </CardContent></Card>
  )
}
