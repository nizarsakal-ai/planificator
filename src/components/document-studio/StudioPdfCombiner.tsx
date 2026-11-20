"use client"
/**
 * Document Studio — espace PDF (lot 3) : « Combiner des PDF ». Choix de 2 à 20 PDF importés, ordre ajustable (boutons ou
 * clavier), titre facultatif. Le serveur reprend la DERNIÈRE version de chacun, dans cet ordre, et crée un NOUVEAU PDF
 * dont les sources sont figées ; les PDF d'origine ne sont pas modifiés. Les PDF chiffrés ne sont pas proposés.
 */
import { useId, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react"
import { FormulaireRetour } from "@/components/crm/RetourFormulaire"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { combinePdfsAction } from "@/lib/actions/document-studio.actions"
import { PDF_LIMITS } from "@/lib/document-studio/pdf-workspace.core"

export interface CombinablePdf { id: string; title: string; pageCount: number; revision: number }

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460] focus-visible:ring-offset-1"

export function StudioPdfCombiner({ pdfs }: { pdfs: CombinablePdf[] }) {
  const uid = useId()
  const [chosen, setChosen] = useState<string[]>([])
  const byId = useMemo(() => new Map(pdfs.map((p) => [p.id, p])), [pdfs])
  const available = pdfs.filter((p) => !chosen.includes(p.id))
  const pages = chosen.reduce((n, id) => n + (byId.get(id)?.pageCount ?? 0), 0)
  const full = chosen.length >= PDF_LIMITS.maxCombineParts
  const tooLong = pages > PDF_LIMITS.maxPages
  const move = (i: number, d: -1 | 1) => setChosen((xs) => {
    const j = i + d
    if (j < 0 || j >= xs.length) return xs
    const c = [...xs]; [c[i], c[j]] = [c[j], c[i]]; return c
  })

  if (pdfs.length < 2) return <p className="text-sm text-slate-600">Importez au moins deux PDF (non protégés) pour les combiner.</p>

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-w-0">
        <h3 id={`${uid}-dispo`} className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">PDF disponibles</h3>
        <ul aria-labelledby={`${uid}-dispo`} className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {available.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Tous les PDF sont choisis.</li>}
          {available.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate"><span className="text-slate-800">{p.title}</span> <span className="text-xs text-slate-500">v{p.revision} · {p.pageCount} p.</span></span>
              <Button type="button" size="sm" variant="outline" disabled={full} onClick={() => setChosen((xs) => [...xs, p.id])} aria-label={`Ajouter ${p.title}`}><Plus aria-hidden="true" className="h-3.5 w-3.5" /></Button>
            </li>
          ))}
        </ul>
      </div>
      <FormulaireRetour action={combinePdfsAction} className="min-w-0 space-y-2">
        <h3 id={`${uid}-ordre`} className="text-xs font-semibold uppercase tracking-wide text-slate-600">Ordre du PDF combiné</h3>
        <ol aria-labelledby={`${uid}-ordre`} className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {chosen.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Ajoutez au moins deux PDF.</li>}
          {chosen.map((id, i) => {
            const p = byId.get(id)
            if (!p) return null
            return (
              <li key={id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-5 text-right text-xs tabular-nums text-slate-500">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-slate-800">{p.title} <span className="text-xs text-slate-500">({p.pageCount} p.)</span></span>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Monter ${p.title}`} className={`rounded p-1 text-slate-600 hover:bg-slate-100 disabled:opacity-30 ${FOCUS}`}><ArrowUp aria-hidden="true" className="h-4 w-4" /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === chosen.length - 1} aria-label={`Descendre ${p.title}`} className={`rounded p-1 text-slate-600 hover:bg-slate-100 disabled:opacity-30 ${FOCUS}`}><ArrowDown aria-hidden="true" className="h-4 w-4" /></button>
                <button type="button" onClick={() => setChosen((xs) => xs.filter((x) => x !== id))} aria-label={`Retirer ${p.title}`} className={`rounded p-1 text-red-700 hover:bg-red-50 ${FOCUS}`}><X aria-hidden="true" className="h-4 w-4" /></button>
              </li>
            )
          })}
        </ol>
        <input type="hidden" name="ids" value={JSON.stringify(chosen)} />
        <label className="grid gap-1 text-xs text-slate-600">Titre (facultatif)
          <Input name="title" maxLength={160} placeholder="Par défaut : premier PDF + nombre d'autres" />
        </label>
        <p className="text-xs text-slate-600" aria-live="polite">
          {chosen.length < 2 ? "La dernière version de chaque PDF est reprise ; les originaux ne sont pas modifiés." : `${chosen.length} PDF · ${pages} page${pages > 1 ? "s" : ""}.`}
          {tooLong && <span className="text-red-700"> Au-delà de {PDF_LIMITS.maxPages} pages : retirez un PDF.</span>}
        </p>
        <Button type="submit" disabled={chosen.length < 2 || tooLong}>Combiner {chosen.length >= 2 ? `${chosen.length} PDF` : ""}</Button>
      </FormulaireRetour>
    </div>
  )
}
