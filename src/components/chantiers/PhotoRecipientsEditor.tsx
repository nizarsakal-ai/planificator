"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PHOTO_RECIPIENTS_FIELD, PHOTO_RECIPIENTS_MAX, PHOTO_RECIPIENT_EMAIL_MAX, PHOTO_RECIPIENT_LABEL_MAX, type PhotoRecipientRow } from "@/lib/chantiers/photo-recipients"

/**
 * Éditeur « Destinataires des photos » (SUPER_ADMIN ; le serveur relit l'autorité et valide tout). AUCUN envoi automatique.
 * Les champs de ligne n'ont pas d'attribut `name` : seule la liste JSON du champ caché est envoyée, et SEULEMENT si elle a
 * été modifiée (sinon champ absent ⇒ configuration conservée). L'adresse historique n'est que suggérée, jamais ajoutée d'office.
 */
export interface PhotoRecipientsEditorProps {
  initialRows: PhotoRecipientRow[]
  historicSuggestion: string | null
  /** Sauvegarde en cours : aucune modification possible (saisie jamais perdue entre l'envoi et la réponse). */
  disabled?: boolean
}

export function PhotoRecipientsEditor({ initialRows, historicSuggestion, disabled = false }: PhotoRecipientsEditorProps) {
  const [rows, setRows] = useState<PhotoRecipientRow[]>(initialRows)
  const [dirty, setDirty] = useState(false)
  const full = rows.length >= PHOTO_RECIPIENTS_MAX
  const suggestion = historicSuggestion && !rows.some((r) => r.email.trim().toLowerCase() === historicSuggestion.toLowerCase()) ? historicSuggestion : null

  function change(next: PhotoRecipientRow[]) { setRows(next); setDirty(true) }
  const update = (i: number, patch: Partial<PhotoRecipientRow>) => change(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <>
    <fieldset className="space-y-2 rounded-md border border-slate-200 p-2" disabled={disabled} aria-busy={disabled}>
      <legend className="px-1 text-xs font-medium text-slate-600">Destinataires des photos</legend>
      <p className="text-[11px] text-slate-500">Destinataires propres à ce chantier. Aucun envoi automatique.</p>
      {rows.length === 0 && (
        <p className="text-xs text-slate-400">{dirty ? "Aucun destinataire : la liste sera vidée à l'enregistrement." : "Aucun destinataire."}</p>
      )}
      {rows.map((row, i) => (
        <div key={i} className="space-y-1.5 rounded-md bg-slate-50 p-2" role="group" aria-label={`Destinataire ${i + 1}`}>
          <Label htmlFor={`photo-recipient-label-${i}`} className="sr-only">Nom ou fonction du destinataire {i + 1}</Label>
          <Input id={`photo-recipient-label-${i}`} value={row.label} maxLength={PHOTO_RECIPIENT_LABEL_MAX} placeholder="Nom / fonction (facultatif)"
            onChange={(e) => update(i, { label: e.target.value })} className="h-8 text-sm" />
          <Label htmlFor={`photo-recipient-email-${i}`} className="sr-only">E-mail du destinataire {i + 1}</Label>
          <Input id={`photo-recipient-email-${i}`} type="email" inputMode="email" autoComplete="off" value={row.email} maxLength={PHOTO_RECIPIENT_EMAIL_MAX}
            placeholder="exemple@client.fr" required onChange={(e) => update(i, { email: e.target.value })} className="h-8 text-sm" />
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={row.active} onChange={(e) => update(i, { active: e.target.checked })} className="h-4 w-4" />
              Actif
            </label>
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs text-red-700" onClick={() => change(rows.filter((_, j) => j !== i))}>
              <Trash2 className="h-3.5 w-3.5" /> Retirer
            </Button>
          </div>
        </div>
      ))}
      {suggestion && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-100 bg-amber-50 p-2 text-xs text-amber-900">
          <span className="min-w-0 flex-1 break-all">Adresse historique (non utilisée) : {suggestion}</span>
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={full}
            onClick={() => change([...rows, { label: "", email: suggestion, active: true }])}>
            Ajouter comme destinataire
          </Button>
        </div>
      )}
      <Button type="button" variant="outline" size="sm" className="h-8 w-full text-xs" disabled={full}
        onClick={() => change([...rows, { label: "", email: "", active: true }])}>
        <Plus className="h-3.5 w-3.5" /> {full ? `${PHOTO_RECIPIENTS_MAX} destinataires au plus` : "Ajouter un destinataire"}
      </Button>
    </fieldset>
    {/* Hors du fieldset désactivable : la liste modifiée reste envoyée même pendant le chargement. */}
    {dirty && <input type="hidden" name={PHOTO_RECIPIENTS_FIELD} value={JSON.stringify(rows.map((r) => ({ label: r.label, email: r.email, active: r.active })))} />}
    </>
  )
}
