"use client"
// Choix du chantier / événement : existant, aucun, ou nouveau client saisi à la main (particulier, sans chantier).
import { useState } from "react"
import { Input } from "@/components/ui/input"

const SELECT = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
export const NEW_EVENT = "__nouveau__"

export function WorksitePicker({ worksites, noneLabel = "Sans chantier", className = "" }: { worksites: { id: string; name: string }[]; noneLabel?: string; className?: string }) {
  const [v, setV] = useState("")
  return (
    <>
      <select name="worksiteId" value={v} onChange={(e) => setV(e.target.value)} className={`${SELECT} ${className}`} aria-label="Chantier ou événement">
        <option value="">{noneLabel}</option>
        <option value={NEW_EVENT}>+ Nouveau client / événement (saisie manuelle)</option>
        {worksites.length > 0 && <optgroup label="Chantiers et événements">{worksites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>}
      </select>
      {v === NEW_EVENT && (
        <div className="grid gap-2 rounded-md border border-blue-200 bg-blue-50/50 p-3 sm:col-span-2 sm:grid-cols-2 lg:col-span-full lg:grid-cols-5">
          <Input name="newClientName" required maxLength={160} placeholder="Nom du client (ex. Mme Dupont)" aria-label="Nom du client" />
          <Input name="newClientPhone" maxLength={40} placeholder="Téléphone" aria-label="Téléphone du client" />
          <Input name="newClientEmail" type="email" maxLength={160} placeholder="E-mail" aria-label="E-mail du client" />
          <Input name="newClientAddress" maxLength={300} placeholder="Adresse / lieu de l'événement" aria-label="Adresse du client" />
          <Input name="newEventName" maxLength={160} placeholder="Événement (ex. Mariage 14/06)" aria-label="Nom de l'événement" />
          <p className="text-xs text-slate-500 sm:col-span-2 lg:col-span-5">Le client (particulier ou société) et l&apos;événement sont créés automatiquement et repris sur le contrat de location.</p>
        </div>
      )}
    </>
  )
}
