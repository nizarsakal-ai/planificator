// Lot G2 Planificator V2 : recherche dans les documents générés. Formulaire de LECTURE seulement (méthode GET, navigation
// native du document vers la liste filtrée) : aucune mutation, donc hors du circuit FormulaireRetour réservé aux actions.
// Les paramètres sont relus et bornés côté serveur (`lireRecherche`).
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS } from "@/components/stock/StockFlash"
import { DOC_ETATS, type DocEtat } from "@/lib/document-studio/tool-hub"
import { DOC_STATUS_LABEL } from "@/components/document-studio/labels"

export function StudioDocumentSearch({ q, etat }: { q: string; etat: DocEtat | null }) {
  return (
    <form method="get" action="/studio-documents#documents" role="search" aria-label="Rechercher dans les documents générés" className="flex flex-wrap items-center gap-2 px-3 py-2">
      <Input name="q" type="search" defaultValue={q} maxLength={80} placeholder="Numéro, titre ou modèle" aria-label="Rechercher un document" className="h-9 max-w-xs" />
      <select name="etat" defaultValue={etat ?? ""} aria-label="État" className={`${SELECT_CLASS} h-9`}>
        <option value="">Tous les états</option>
        {DOC_ETATS.map((e) => <option key={e} value={e}>{DOC_STATUS_LABEL[e]}</option>)}
      </select>
      <Button type="submit" size="sm" variant="outline">Rechercher</Button>
      {(q || etat) && <a href="/studio-documents#documents" className="text-xs text-[#0f3460] underline">Effacer</a>}
    </form>
  )
}
