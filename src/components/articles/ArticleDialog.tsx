"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Package, Loader2, Plus, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { createArticle, updateArticle } from "@/lib/actions/article.actions"

export interface ArticleData {
  id: string
  reference: string | null
  designation: string
  description: string | null
  unit: string
  unitPrice: number
  vatRate: number
}

export function ArticleDialog({ article }: { article?: ArticleData }) {
  const router = useRouter()
  const isEdit = !!article
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    const formData = new FormData(e.currentTarget)
    const result = isEdit
      ? await updateArticle(article!.id, formData)
      : await createArticle(formData)
    setLoading(false)

    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success(isEdit ? "Article mis à jour." : "Article ajouté.")
      setOpen(false)
      router.refresh()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {isEdit ? (
          <button
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-slate-400 hover:text-[#0f3460] transition-colors"
            title="Modifier"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : (
          <Button className="bg-[#0f3460] hover:bg-[#0a2540] gap-1.5">
            <Plus className="h-4 w-4" />
            Nouvel article
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-[#0f3460]" />
            {isEdit ? "Modifier l'article" : "Nouvel article"}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Référence</Label>
              <Input name="reference" defaultValue={article?.reference ?? ""} placeholder="PLB-001" />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-slate-500">Désignation *</Label>
              <Input name="designation" defaultValue={article?.designation ?? ""} placeholder="Fourniture et pose…" required />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-slate-500">Description</Label>
            <textarea
              name="description"
              defaultValue={article?.description ?? ""}
              placeholder="Détail optionnel…"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Unité *</Label>
              <Input name="unit" defaultValue={article?.unit ?? "u"} placeholder="u, m², ml, h…" required />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Prix HT (€) *</Label>
              <Input name="unitPrice" type="number" step="0.01" min="0" defaultValue={article?.unitPrice ?? ""} placeholder="0.00" required />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">TVA (%) *</Label>
              <Input name="vatRate" type="number" step="0.01" min="0" max="100" defaultValue={article?.vatRate ?? 20} required />
            </div>
          </div>

          <Button type="submit" disabled={loading} className="w-full bg-[#0f3460] hover:bg-[#0a2540]">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : isEdit ? "Enregistrer" : "Ajouter l'article"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
