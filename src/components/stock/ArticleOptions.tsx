// Options d'un menu déroulant d'articles de stock : le catalogue événementiel complet (même liste que Matériel),
// regroupé par famille. Un élément déjà présent en base utilise son article ; sinon sa valeur « evt:RÉF » fait créer
// l'article au premier mouvement. `withOthers` ajoute les autres articles (ex. achats de prestations).
import { EVENT_CATALOG, EVENT_REF_PREFIX, eventArticleReference, eventArticleUnit } from "@/components/equipment/event-catalog"

type ArticleOption = { id: string; reference: string | null; designation: string; unit: string }

const norm = (s: string) => s.trim().toLowerCase()

export function ArticleOptions({ articles, withOthers = false }: { articles: ArticleOption[]; withOthers?: boolean }) {
  const byRef = new Map(articles.filter((a) => a.reference).map((a) => [a.reference!, a]))
  const byName = new Map(articles.map((a) => [norm(a.designation), a]))
  const used = new Set<string>()
  const groups = EVENT_CATALOG.map((g) => ({
    group: g.group,
    items: g.items.map((it) => {
      const ref = eventArticleReference(it.name)
      const designation = it.name.replace(/\s*\(m²\)$/, "")
      const existing = byRef.get(ref) ?? byName.get(norm(designation))
      if (existing) used.add(existing.id)
      return { value: existing?.id ?? `evt:${ref}`, label: `${designation} (${existing?.unit ?? eventArticleUnit(it.name)})` }
    }),
  }))
  // Articles événementiels ajoutés hors catalogue (référence EVT-), toujours proposés.
  const extraEvent = articles.filter((a) => a.reference?.startsWith(EVENT_REF_PREFIX) && !used.has(a.id))
  const others = withOthers ? articles.filter((a) => !used.has(a.id) && !a.reference?.startsWith(EVENT_REF_PREFIX)) : []
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.group} label={g.group}>{g.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
      ))}
      {extraEvent.length > 0 && <optgroup label="Autre matériel événementiel">{extraEvent.map((a) => <option key={a.id} value={a.id}>{a.designation} ({a.unit})</option>)}</optgroup>}
      {others.length > 0 && <optgroup label="Autres articles">{others.map((a) => <option key={a.id} value={a.id}>{a.reference ? `${a.reference} · ` : ""}{a.designation} ({a.unit})</option>)}</optgroup>}
    </>
  )
}
