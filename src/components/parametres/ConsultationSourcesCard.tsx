"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Users, Plus } from "lucide-react"
import type { PartnerSourceView } from "@/lib/acquisition/admin/partner-sources"
import {
  addConsultationSourceAction,
  setConsultationSourceDomainActiveAction,
} from "@/lib/actions/acquisition-sources.actions"

/**
 * Expéditeurs dont les e-mails deviennent des consultations (registre partenaires).
 * Un e-mail d'un domaine absent de cette liste est ignoré par l'import.
 */
export function ConsultationSourcesCard({ sources }: { sources: PartnerSourceView[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [domain, setDomain] = useState("")
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setFeedback(null)
    startTransition(async () => {
      const res = await addConsultationSourceAction({ name, domain })
      if (res.ok) {
        setName("")
        setDomain("")
        setFeedback({ ok: true, text: res.message })
        router.refresh()
      } else {
        setFeedback({ ok: false, text: res.error })
      }
    })
  }

  function toggle(domainId: string, active: boolean) {
    setFeedback(null)
    startTransition(async () => {
      const res = await setConsultationSourceDomainActiveAction({ domainId, active })
      setFeedback(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
      if (res.ok) router.refresh()
    })
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-slate-600" />
        <h3 className="font-medium text-slate-900">Expéditeurs des consultations</h3>
      </div>
      <p className="text-sm text-slate-600">
        Seuls les e-mails de ces domaines deviennent des consultations. Ajoutez un client donneur
        d&apos;ordre (ex. ATS → ats67.com) pour importer ses demandes.
      </p>

      <ul className="space-y-2">
        {sources.length === 0 && <li className="text-sm text-slate-500">Aucun expéditeur enregistré.</li>}
        {sources.map((p) => (
          <li key={p.id} className="text-sm border border-slate-100 rounded px-3 py-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-800">{p.name}</span>
              {!p.active && <span className="text-xs text-slate-400">inactif</span>}
            </div>
            <ul className="space-y-1">
              {p.domains.length === 0 && <li className="text-xs text-slate-500">Aucun domaine.</li>}
              {p.domains.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-xs ${d.active ? "text-slate-700" : "text-slate-400 line-through"}`}>
                    {d.domain}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => toggle(d.id, !d.active)}
                    className="text-xs text-slate-500 underline disabled:opacity-60"
                  >
                    {d.active ? "Désactiver" : "Réactiver"}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom (ex. ATS)"
          aria-label="Nom de l'expéditeur"
          maxLength={200}
          className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
        />
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="Domaine ou e-mail (ex. ats67.com)"
          aria-label="Domaine e-mail de l'expéditeur"
          maxLength={320}
          className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={pending || !name.trim() || !domain.trim()}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          {pending ? "Ajout…" : "Ajouter"}
        </button>
      </form>
      {feedback && (
        <p role="status" className={`text-xs ${feedback.ok ? "text-emerald-700" : "text-red-600"}`}>
          {feedback.text}
        </p>
      )}
    </div>
  )
}
