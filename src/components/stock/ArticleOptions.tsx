// Options d'un menu déroulant d'articles : le matériel événementiel (références EVT-) en tête, regroupé, puis les autres articles.
import { EVENT_REF_PREFIX } from "@/components/equipment/event-catalog"

type ArticleOption = { id: string; reference: string | null; designation: string; unit: string }

export function ArticleOptions({ articles }: { articles: ArticleOption[] }) {
  const event = articles.filter((a) => a.reference?.startsWith(EVENT_REF_PREFIX))
  const others = articles.filter((a) => !a.reference?.startsWith(EVENT_REF_PREFIX))
  const label = (a: ArticleOption) => `${a.reference && !a.reference.startsWith(EVENT_REF_PREFIX) ? `${a.reference} · ` : ""}${a.designation} (${a.unit})`
  if (event.length === 0) return <>{others.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}</>
  return (
    <>
      <optgroup label="Matériel événementiel">{event.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}</optgroup>
      {others.length > 0 && <optgroup label="Autres articles">{others.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}</optgroup>}
    </>
  )
}
