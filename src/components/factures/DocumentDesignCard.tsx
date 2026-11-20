"use client"
// 20/11/2026 — apparence du PDF d'UN brouillon (facture, acompte, avoir ou devis) : réglage de la société ou design propre.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { FileText, Loader2, Palette } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { saveDocumentDesignAction } from "@/lib/actions/pdf-design.actions"
import { PDF_LAYOUT_LABEL, PDF_TEMPLATE_LABEL, validateDesign } from "@/lib/billing/pdf/design"
import { PdfDesignPicker, type PdfDesignValue } from "@/components/factures/PdfDesignPicker"

interface Props {
  kind: "invoice" | "quote"
  id: string
  /** Design propre au document, ou null s'il suit le réglage de la société. */
  documentDesign: PdfDesignValue | null
  companyDesign: PdfDesignValue
  bankAvailable: boolean
  pdfHref: string
}

export function DocumentDesignCard({ kind, id, documentDesign, companyDesign, bankAvailable, pdfHref }: Props) {
  const router = useRouter()
  const [custom, setCustom] = useState(documentDesign !== null)
  const [value, setValue] = useState<PdfDesignValue>(documentDesign ?? companyDesign)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const label = (d: PdfDesignValue) => `${PDF_TEMPLATE_LABEL[d.template]} · ${PDF_LAYOUT_LABEL[d.layout]}`

  async function save() {
    if (custom && !validateDesign(value).ok) { toast.error("Corrigez les couleurs avant d'enregistrer."); return }
    setBusy(true)
    try {
      const r = await saveDocumentDesignAction({ kind, id, design: custom ? value : null })
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Apparence du PDF enregistrée.")
      setOpen(false)
      router.refresh()
    } catch { toast.error("Erreur serveur.") } finally { setBusy(false) }
  }

  return (
    <Card><CardContent className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-slate-500" />
          <span className="font-medium text-slate-700">Apparence du PDF</span>
          <span className="text-slate-500">— {documentDesign ? `${label(documentDesign)} (propre à ce document)` : `${label(companyDesign)} (réglage de la société)`}</span>
          <span className="flex"><span className="h-4 w-4 rounded-full border border-white" style={{ background: (documentDesign ?? companyDesign).primary }} /><span className="-ml-1.5 h-4 w-4 rounded-full border border-white" style={{ background: (documentDesign ?? companyDesign).secondary }} /></span>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" asChild><a href={pdfHref} target="_blank" rel="noopener noreferrer"><FileText className="h-4 w-4" /> Voir le PDF</a></Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(!open)}>{open ? "Fermer" : "Modifier"}</Button>
        </div>
      </div>
      {open && (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2"><input type="radio" name={`design-${id}`} checked={!custom} onChange={() => setCustom(false)} /> Suivre le réglage de la société ({label(companyDesign)})</label>
            <label className="flex items-center gap-2"><input type="radio" name={`design-${id}`} checked={custom} onChange={() => setCustom(true)} /> Personnaliser ce document</label>
          </div>
          {custom && <PdfDesignPicker value={value} onChange={setValue} bankAvailable={bankAvailable} />}
          <p className="text-xs text-slate-500">Le design est figé à l&apos;émission : le document envoyé gardera cette apparence.</p>
          <div className="flex justify-end"><Button type="button" onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer l&apos;apparence</Button></div>
        </div>
      )}
    </CardContent></Card>
  )
}
