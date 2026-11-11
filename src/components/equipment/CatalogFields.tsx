"use client"
// Création simplifiée : on choisit un article du catalogue et une quantité ; désignation, catégorie et n° interne sont
// générés automatiquement (aperçu en direct). « Autre » ouvre la saisie libre.
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { EVENT_CATALOG, EVENT_STOCK_ARTICLES } from "@/components/equipment/event-catalog"

const SELECT = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
const OTHER = "__autre__"

export function CatalogFields() {
  const [ref, setRef] = useState("")
  const [qty, setQty] = useState("1")
  const item = EVENT_STOCK_ARTICLES.find((a) => a.reference === ref)
  const n = Math.max(1, Math.min(200, Math.floor(Number(qty)) || 1))
  return (
    <>
      <select name="catalogRef" required aria-label="Matériel" className={`${SELECT} sm:col-span-2 lg:col-span-3`} value={ref} onChange={(e) => setRef(e.target.value)}>
        <option value="" disabled>Choisir le matériel (tente, photobooth, mobilier, son…)</option>
        {EVENT_CATALOG.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((it) => { const a = EVENT_STOCK_ARTICLES.find((x) => x.designation === it.name.replace(/\s*\(m²\)$/, ""))!; return <option key={a.reference} value={a.reference}>{a.designation}</option> })}
          </optgroup>
        ))}
        <option value={OTHER}>Autre (saisie libre)</option>
      </select>
      <Input name="quantity" type="number" min={1} max={200} value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantité" placeholder="Quantité" />
      {ref === OTHER && <>
        <Input name="name" required maxLength={160} placeholder="Désignation" aria-label="Désignation" />
        <Input name="category" required maxLength={80} placeholder="Catégorie" aria-label="Catégorie" />
      </>}
      {item && (
        <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900 sm:col-span-2 lg:col-span-4">
          {item.tracked
            ? <>Création automatique de <b>{n} fiche{n > 1 ? "s" : ""}</b> « {item.designation} » · catégorie {item.category} · n° <b>{item.code}-001</b>{n > 1 ? " et suivants" : ""} (prochains numéros libres) · stock du dépôt mis à jour.</>
            : <>{item.designation} se gère en quantité : <b>{n} {item.unit === "m²" ? "m²" : n > 1 ? "unités" : "unité"}</b> entré{n > 1 ? "es" : "e"} directement en stock dans le dépôt choisi (pas de fiche individuelle).</>}
        </p>
      )}
    </>
  )
}
