"use client"
// Menu déroulant du catalogue événementiel : choisir un article pré-remplit la désignation et la catégorie.
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { EVENT_CATALOG } from "@/components/equipment/event-catalog"

const SELECT = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm"

export function CatalogFields() {
  const [name, setName] = useState("")
  const [category, setCategory] = useState("")
  return (
    <>
      <select
        aria-label="Matériel du catalogue"
        className={`${SELECT} sm:col-span-2 lg:col-span-4`}
        defaultValue=""
        onChange={(e) => {
          const [g, i] = e.target.value.split(":").map(Number)
          const item = EVENT_CATALOG[g]?.items[i]
          if (item) { setName(item.name); setCategory(item.category) }
        }}
      >
        <option value="">Choisir dans le catalogue (tente, photobooth, mobilier, son…) ou saisir librement</option>
        {EVENT_CATALOG.map((g, gi) => (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((it, ii) => <option key={it.name} value={`${gi}:${ii}`}>{it.name}</option>)}
          </optgroup>
        ))}
      </select>
      <Input name="name" required maxLength={160} placeholder="Désignation" aria-label="Désignation" value={name} onChange={(e) => setName(e.target.value)} />
      <Input name="category" required maxLength={80} placeholder="Catégorie (ex. Tente)" aria-label="Catégorie" value={category} onChange={(e) => setCategory(e.target.value)} />
    </>
  )
}
