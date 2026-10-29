"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Download, Loader2, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { removeCompanyLogo, uploadCompanyLogo } from "@/lib/actions/company-logo.actions"

interface Props {
  companyName: string
  logoUrl: string | null
  /** Logo géré (data URL PNG normalisée) : téléchargeable et embarqué dans les PDF. */
  managed: boolean
}

const ACCEPT = "image/png,image/jpeg,image/webp"
const MAX_BYTES = 2 * 1024 * 1024

export function CompanyLogoCard({ companyName, logoUrl, managed }: Props) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null)
  const preview = logoUrl

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file || busy) return
    if (file.size > MAX_BYTES) { toast.error("Fichier trop volumineux (2 Mo maximum)."); return }
    setBusy("upload")
    try {
      const fd = new FormData()
      fd.append("file", file)
      const r = await uploadCompanyLogo(fd)
      if (!r.ok) { toast.error(r.error); return }
      toast.success(`Logo enregistré (${r.width}×${r.height} px).`)
      router.refresh()
    } catch {
      toast.error("Erreur serveur, réessayez.")
    } finally {
      setBusy(null)
    }
  }

  async function onRemove() {
    if (busy) return
    if (!window.confirm("Retirer le logo ? Les prochains devis et factures seront générés sans logo.")) return
    setBusy("remove")
    try {
      const r = await removeCompanyLogo()
      if (!r.ok) { toast.error(r.error); return }
      toast.success("Logo retiré.")
      router.refresh()
    } catch {
      toast.error("Erreur serveur, réessayez.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex h-24 w-full items-center justify-center rounded-md border border-dashed border-slate-300 bg-white p-2 sm:w-48" aria-label="Aperçu du logo">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt={`Logo ${companyName}`} className="max-h-20 max-w-full object-contain" />
          ) : (
            <span className="text-xs text-slate-400">Aucun logo</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => inputRef.current?.click()} disabled={busy !== null} className="bg-[#0f3460] hover:bg-[#0a2540]">
            {busy === "upload" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {preview ? "Remplacer le logo" : "Importer un logo"}
          </Button>
          {managed && (
            <Button type="button" size="sm" variant="outline" asChild>
              <a href="/api/company/logo" download><Download className="mr-2 h-4 w-4" />Télécharger</a>
            </Button>
          )}
          {preview && (
            <Button type="button" size="sm" variant="outline" onClick={onRemove} disabled={busy !== null}>
              {busy === "remove" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Retirer
            </Button>
          )}
        </div>
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" aria-label={`Importer le logo de ${companyName}`} onChange={onFile} />
      </div>
      <p className="text-xs text-slate-500">
        PNG, JPEG ou WebP, 2 Mo maximum ; l&apos;image est vérifiée (type réel), redimensionnée (1200 × 480 px max) et enregistrée en PNG pour les devis et factures de cette entreprise uniquement.
        {logoUrl && !managed && " Le logo actuel provient d'une URL externe : il n'est ni téléchargeable ni intégré aux PDF ; importez un fichier pour le remplacer."}
      </p>
    </div>
  )
}
