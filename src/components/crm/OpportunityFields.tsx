// Lot E : champs communs du formulaire d'opportunité (création et modification), composant serveur sans état.
import { Input } from "@/components/ui/input"
import { SELECT_CLASS } from "@/components/stock/StockFlash"
import { centsToInput } from "@/components/crm/labels"

type Options = {
  clients: { id: string; name: string }[]; worksites: { id: string; name: string }[]; quotes: { id: string; number: string; client: { name: string } }[]
  consultations: { id: string; proposedWorksiteName: string | null; proposedClientName: string | null }[]; employees: { id: string; firstName: string; lastName: string }[]
}
type Values = Partial<{
  title: string; clientId: string | null; prospectName: string | null; amountCents: bigint; probabilityBp: number; expectedCloseDate: Date | null
  nextFollowUpDate: Date | null; followUpNote: string | null; worksiteId: string | null; quoteId: string | null; consultationDraftId: string | null; ownerEmployeeId: string | null
}>
const dayInput = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "")

export function OpportunityFields({ options: o, values: v = {} }: { options: Options; values?: Values }) {
  return (
    <>
      <Input name="title" required minLength={3} maxLength={200} defaultValue={v.title ?? ""} placeholder="Intitulé (ex. rénovation façade)" aria-label="Intitulé" className="sm:col-span-2" />
      <select name="clientId" defaultValue={v.clientId ?? ""} className={SELECT_CLASS} aria-label="Client"><option value="">Prospect (sans fiche client)</option>{o.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <Input name="prospectName" maxLength={200} defaultValue={v.prospectName ?? ""} placeholder="Nom du prospect (si pas de client)" aria-label="Nom du prospect" />
      <Input name="amount" inputMode="decimal" defaultValue={v.amountCents !== undefined ? centsToInput(v.amountCents) : ""} placeholder="Montant HT estimé (€)" aria-label="Montant HT estimé" />
      <Input name="probability" inputMode="decimal" defaultValue={v.probabilityBp !== undefined ? String(v.probabilityBp / 100).replace(".", ",") : ""} placeholder="Probabilité % (défaut de l'étape)" aria-label="Probabilité en pour cent" />
      <label className="grid gap-1 text-xs uppercase text-slate-500">Signature prévue<Input name="expectedCloseDate" type="date" defaultValue={dayInput(v.expectedCloseDate)} /></label>
      <label className="grid gap-1 text-xs uppercase text-slate-500">Prochaine relance<Input name="nextFollowUpDate" type="date" defaultValue={dayInput(v.nextFollowUpDate)} /></label>
      <select name="ownerId" defaultValue={v.ownerEmployeeId ?? ""} className={SELECT_CLASS} aria-label="Responsable"><option value="">Sans responsable</option>{o.employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select>
      <select name="worksiteId" defaultValue={v.worksiteId ?? ""} className={SELECT_CLASS} aria-label="Chantier"><option value="">Sans chantier</option>{o.worksites.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <select name="quoteId" defaultValue={v.quoteId ?? ""} className={SELECT_CLASS} aria-label="Devis lié"><option value="">Sans devis</option>{o.quotes.map((q) => <option key={q.id} value={q.id}>{q.number} · {q.client.name}</option>)}</select>
      <select name="consultationDraftId" defaultValue={v.consultationDraftId ?? ""} className={SELECT_CLASS} aria-label="Consultation liée"><option value="">Sans consultation</option>{o.consultations.map((c) => <option key={c.id} value={c.id}>{c.proposedWorksiteName ?? "Consultation"}{c.proposedClientName ? ` · ${c.proposedClientName}` : ""}</option>)}</select>
      <Input name="followUpNote" maxLength={1000} defaultValue={v.followUpNote ?? ""} placeholder="Objet de la prochaine relance (facultatif)" aria-label="Objet de la relance" className="sm:col-span-2" />
    </>
  )
}
