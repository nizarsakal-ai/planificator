// Lot G2 Planificator V2 : recherche dans les documents générés. Formulaire de LECTURE seulement (méthode GET, navigation
// native du document vers la liste filtrée) : aucune mutation, donc hors du circuit FormulaireRetour réservé aux actions.
// Les paramètres sont relus et bornés côté serveur (`lireRecherche`).
// La vue ouverte (?vue=) et le modèle de départ choisi (?depart=) sont reconduits tels quels : ce sont les valeurs déjà
// validées par la page (listes fermées), jamais le texte brut de l'adresse.
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS } from "@/components/stock/StockFlash"
import { DOC_ETATS, type DocEtat, type StudioVue } from "@/lib/document-studio/tool-hub"
import { DOC_STATUS_LABEL } from "@/components/document-studio/labels"

export function StudioDocumentSearch({ q, etat, vue = null, depart = null }: { q: string; etat: DocEtat | null; vue?: StudioVue | null; depart?: string | null }) {
  const contexte = new URLSearchParams()
  if (vue) contexte.set("vue", vue)
  if (depart) contexte.set("depart", depart)
  const effacer = `/studio-documents${contexte.size > 0 ? `?${contexte.toString()}` : ""}#documents`
  return (
    <form method="get" action="/studio-documents#documents" role="search" aria-label="Rechercher dans les documents générés" className="flex flex-wrap items-center gap-2 px-3 py-2">
      {vue && <input type="hidden" name="vue" value={vue} />}
      {depart && <input type="hidden" name="depart" value={depart} />}
      <Input name="q" type="search" defaultValue={q} maxLength={80} placeholder="Numéro, titre ou modèle" aria-label="Rechercher un document" className="h-9 max-w-xs" />
      <select name="etat" defaultValue={etat ?? ""} aria-label="État" className={`${SELECT_CLASS} h-9`}>
        <option value="">Tous les états</option>
        {DOC_ETATS.map((e) => <option key={e} value={e}>{DOC_STATUS_LABEL[e]}</option>)}
      </select>
      <Button type="submit" size="sm" variant="outline">Rechercher</Button>
      {(q || etat) && <a href={effacer} className="text-xs text-[#0f3460] underline">Effacer</a>}
    </form>
  )
}
