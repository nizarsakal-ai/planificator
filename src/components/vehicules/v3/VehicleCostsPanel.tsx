"use client"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { companyCivilTimeToIso } from "@/lib/vehicules/v3/tour-time"
import type { VehicleCostsDto,TripCostsDto } from "@/lib/vehicules/v3/cost-service"
interface Expense { documentVersionId?:string|null; maintenanceEntryId?:string|null; id: string; category: string; occurredAt: string; amount: string; currency: string; litres: string | null; mileageObservation: number | null; supplier: string | null; reference: string | null; notes: string | null; status: string; revision: number; sourceExpenseReportId: string | null; sourceWarning: string | null; allocations:{id:string;mileageTripId:string|null;amount:string;label:string}[]; duplicateCandidates: { id: string; truckId: string;label:string }[] }
const names: Record<string, string> = { FUEL: "Carburant", MAINTENANCE: "Entretien / réparation", INSURANCE: "Assurance", OTHER: "Autres", PENDING: "À valider", APPROVED: "Admise", REJECTED: "Refusée", CANCELLED: "Annulée" }
const field = "block border rounded p-2 w-full text-black bg-white"
const button = "border rounded px-3 py-2 disabled:opacity-50"
export function VehicleCostsPanel({ truckId, timeZone }: { truckId: string; timeZone:string }) {
  const companyDate=(value:string|Date)=>new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(value))
  const today=companyDate(new Date()), first=today.slice(0,8)+"01"
  const normalizeDecimal=(value:FormDataEntryValue|null)=>String(value??"").trim().replace(",",".")
  const [from, setFrom] = useState(first), [to, setTo] = useState(today), [currency, setCurrency] = useState("EUR")
  const [sourceCandidates, setSourceCandidates] = useState<{ id: string; date: string; amount: string; description: string; status: string }[]>([])
  const [costs, setCosts] = useState<VehicleCostsDto | null>(null), [expenses, setExpenses] = useState<Expense[]>([]), [offset, setOffset] = useState<number | null>(null)
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [edit, setEdit] = useState<Expense | null>(null)
  const [reason, setReason] = useState(""), [target, setTarget] = useState<Expense | null>(null), [action, setAction] = useState("APPROVE"), [source, setSource] = useState(""), [trip, setTrip] = useState(""), [allocated, setAllocated] = useState("")
  const [tripCandidates,setTripCandidates]=useState<{id:string;label:string}[]>([]),[costTripId,setCostTripId]=useState("")
  const [tripCosts,setTripCosts]=useState<TripCostsDto|null>(null)
  const [documents,setDocuments]=useState<{id:string;title:string;category:string;archivedAt?:string|null;currentVersion:{id:string;versionNumber:number}|null}[]>([]),[maintenance,setMaintenance]=useState<{id:string;kind:string;occurredAt:string;mileage:number}[]>([])
  const [documentError,setDocumentError]=useState(""),[maintenanceError,setMaintenanceError]=useState(""),[documentLoading,setDocumentLoading]=useState(true),[maintenanceLoading,setMaintenanceLoading]=useState(true)
  const requestRef = useRef<{ body: string; key: string } | null>(null)
  const base = `/api/trucks/${encodeURIComponent(truckId)}`
  const load = useCallback(async (signal?:AbortSignal) => {
    setError("");setCosts(null)
    const end = new Date(`${to}T12:00:00Z`); end.setUTCDate(end.getUTCDate()+1)
    const query = new URLSearchParams({ from: companyCivilTimeToIso(`${from}T00:00`,timeZone), to: companyCivilTimeToIso(`${end.toISOString().slice(0,10)}T00:00`,timeZone), currency })
    const responses = await Promise.all([fetch(`${base}/costs?${query}`, { cache: "no-store",signal }), fetch(`${base}/expenses`, { cache: "no-store",signal })])
    const data = await Promise.all(responses.map(r => r.json()))
    if(signal?.aborted)return
    if (responses.some(r => !r.ok)) { setCosts(null); setExpenses([]); throw new Error("Accès refusé ou période invalide. Les coûts détaillés sont réservés aux administrateurs.") }
    setCosts(data[0]); setExpenses(data[1].expenses); setSourceCandidates(data[1].sourceCandidates); setOffset(data[1].nextOffset);setTripCandidates(data[1].tripCandidates);setTripCosts(null)
  }, [base, from, to, currency,timeZone])
  useEffect(() => {const controller=new AbortController();void load(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error&&e.message.startsWith("Accès refusé")?e.message:"La période est invalide ou le chargement est interrompu. Vérifiez les dates puis réessayez.")});return()=>controller.abort()},[load])
  useEffect(()=>{const controller=new AbortController();setDocuments([]);setMaintenance([]);setDocumentError("");setMaintenanceError("");setDocumentLoading(true);setMaintenanceLoading(true);void fetch(`${base}/documents`,{cache:"no-store",signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error();const data=await r.json();if(!controller.signal.aborted)setDocuments(data.documents)}).catch(()=>{if(!controller.signal.aborted)setDocumentError("Les justificatifs privés sont indisponibles. Les liens déjà enregistrés seront conservés.")}).finally(()=>{if(!controller.signal.aborted)setDocumentLoading(false)});void fetch(`${base}/maintenance`,{cache:"no-store",signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error();const data=await r.json();if(!controller.signal.aborted)setMaintenance(data.history)}).catch(()=>{if(!controller.signal.aborted)setMaintenanceError("Les interventions sont indisponibles. Les liens déjà enregistrés seront conservés.")}).finally(()=>{if(!controller.signal.aborted)setMaintenanceLoading(false)});return()=>controller.abort()},[base])
  async function command(payload: unknown) {
    if (busy) return
    setBusy(true); setError(""); setMessage("")
    const body = JSON.stringify(payload)
    if (requestRef.current?.body !== body) requestRef.current = { body, key: crypto.randomUUID() }
    try {
      const response = await fetch(`${base}/expenses`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestRef.current.key }, body })
      const data = await response.json()
      if (!response.ok) { if (response.status < 500) requestRef.current = null; throw new Error(response.status===409?"La dépense ou sa source a changé. Rechargez et vérifiez la version avant de réessayer.":"Opération refusée. Vérifiez les informations et vos droits, puis réessayez.") }
      requestRef.current = null
      setMessage("Dépense enregistrée. Une correction exige une nouvelle approbation."); setTarget(null); setEdit(null); setReason("")
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : "Erreur de connexion") } finally { setBusy(false) }
  }
  async function loadTripCosts(){if(!costTripId||busy)return;setBusy(true);setError("");setTripCosts(null);try{const query=new URLSearchParams({tripId:costTripId,currency});const r=await fetch(`${base}/costs?${query}`,{cache:"no-store"});if(!r.ok)throw new Error("Le coût affecté à ce trajet est indisponible. Vérifiez vos droits et la devise.");setTripCosts(await r.json())}catch(e){setError(e instanceof Error?e.message:"Erreur de connexion")}finally{setBusy(false)}}
  function submitExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    try {
      const selectedDocument=String(form.get("documentVersionId")??""),selectedMaintenance=String(form.get("maintenanceEntryId")??"")
      const data = { category: form.get("category"), occurredAt: edit&&form.get("date")===companyDate(edit.occurredAt)?edit.occurredAt:companyCivilTimeToIso(`${form.get("date")}T00:00`,timeZone), amount: normalizeDecimal(form.get("amount")), currency: form.get("currency"), litres: form.get("litres") ? normalizeDecimal(form.get("litres")) : null, mileageObservation: form.get("mileage") ? Number(form.get("mileage")) : null, supplier: form.get("supplier") || null, reference: form.get("reference") || null, notes: form.get("notes") || null,
        ...(!edit||selectedDocument!==(edit.documentVersionId??"")?{documentVersionId:selectedDocument||null}:{}),
        ...(!edit||selectedMaintenance!==(edit.maintenanceEntryId??"")?{maintenanceEntryId:selectedMaintenance||null}:{}) }
      void command(edit ? { action: "CORRECT", expenseId: edit.id, expectedRevision: edit.revision, reason: form.get("reason"), data } : { action: "CREATE", data })
    }catch{setError("Cette date à minuit est impossible ou ambiguë dans le fuseau de l’entreprise. Vérifiez la date choisie.")}
  }

  function submitAction(event: FormEvent) {
    event.preventDefault(); if (!target) return
    const payload = { action, expenseId: target.id, expectedRevision: target.revision, reason,
      ...(action === "RECONCILE" ? { sourceExpenseReportId: source, confirmedCurrency: target.currency, confirmedAmount: target.amount } : {}),
      ...(action === "ALLOCATE" ? { allocations: allocated ? [{ mileageTripId: trip || null, amount: allocated.trim().replace(",",".") }] : [] } : {}) }
    void command(payload)
  }
  return <div className="space-y-6">
    <p>Montants saisis dans la devise indiquée, sans conversion. Le compteur observé sur un ticket ne modifie pas le journal kilométrique.</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}<p role="status">{message}</p>
    <section aria-labelledby="cost-period" className="border rounded p-4 space-y-3"><h2 id="cost-period" className="text-xl font-semibold">Coûts sur la période</h2>
      <div className="grid md:grid-cols-3 gap-3"><label>Du ({timeZone})<input className={field} type="date" value={from} onChange={e => setFrom(e.target.value)} required /></label><label>Au inclus ({timeZone})<input className={field} type="date" value={to} onChange={e => setTo(e.target.value)} required /></label><label>Devise (ISO)<input className={field} pattern="[A-Z]{3}" maxLength={3} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} /></label></div>
      {costs && <><p><strong>{costs.realKm} km</strong> : {costs.closedTrips} trajet(s) clos entièrement dans la période. {costs.crossingTrips} trajet(s) à cheval sur les limites et {costs.openTrips} trajet(s) ouvert(s) exclus. Couverture partielle du kilométrage véhicule.</p>
        <dl className="grid md:grid-cols-2 gap-2">{Object.entries(costs.totals).map(([k, v]) => <div key={k}><dt>{names[k]}</dt><dd>{v} {currency}</dd></div>)}<div><dt>Total admis</dt><dd>{costs.total} {currency}</dd></div><div><dt>Coût / km couvert (partiel)</dt><dd>{costs.costPerKm ?? "Non calculable"} {costs.costPerKm && `${currency}/km`}</dd></div><div><dt>Achats carburant / km couvert</dt><dd>{costs.fuelPurchasesPerKm ?? "Non calculable"}</dd></div><div><dt>Prix moyen d'achat / litre renseigné</dt><dd>{costs.averagePurchasePricePerLitre ?? "Non calculable"}</dd></div></dl>
        <p>Achats : {costs.purchasedLitres} L renseignés ; {costs.unknownLitresPurchases} achat(s) sans litres. Les achats ne mesurent pas la consommation.</p>
        <p>Coût complet : partiel. Postes sans montant admis : {costs.missingCategories.map(k => names[k]).join(", ") || "aucun parmi les quatre catégories ; exhaustivité non certifiée"}. Sources à rapprocher exclues : {costs.excludedSource}. Autres devises exclues : {costs.excludedCurrency}.</p></>}
    </section>
    <section className="border rounded p-4 space-y-3"><h2 className="text-xl font-semibold">Coûts affectés à un trajet</h2><p>Uniquement les imputations explicites au trajet choisi, quelle que soit la date d’achat. Ces montants proviennent du registre et ne sont jamais ajoutés au total du véhicule. Le calcul ne mesure pas la consommation réelle.</p><label>Trajet récent<select className={field} value={costTripId} onChange={e=>{setCostTripId(e.target.value);setTripCosts(null)}}><option value="">Choisir un trajet</option>{tripCandidates.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label><button className={button} disabled={busy||!costTripId} onClick={()=>void loadTripCosts()}>Afficher le coût affecté dans la devise {currency}</button>{tripCosts&&<><p>{tripCosts.label} — {tripCosts.actualKm??"distance indisponible"} {tripCosts.actualKm!==null&&"km réels"}</p><p>Coût affecté : {tripCosts.total} {tripCosts.currency}, dont carburant : {tripCosts.totals.FUEL} {tripCosts.currency}.</p><p>Coût affecté par km : {tripCosts.costPerKm??"Non calculable (trajet ouvert, distance inconnue ou zéro kilomètre)"} {tripCosts.costPerKm&&`${tripCosts.currency}/km`}. Carburant affecté par km : {tripCosts.fuelAllocatedCostPerKm??"Non calculable"}.</p><p>Indicateurs partiels : {tripCosts.admittedAllocations} imputation(s) admise(s), {tripCosts.excludedSource} source(s) à rapprocher, {tripCosts.excludedCurrency} imputation(s) dans une autre devise et {tripCosts.excludedPending} dépense(s) non admise(s) exclues.</p></>}</section>
    <section className="border rounded p-4"><h2 className="text-xl font-semibold">{edit ? "Corriger une dépense" : "Proposer une dépense"}</h2>
      <form key={edit?.id ?? "new"} onSubmit={submitExpense} className="grid md:grid-cols-2 gap-3">
        <label>Catégorie<select name="category" className={field} defaultValue={edit?.category ?? "FUEL"}>{["FUEL", "MAINTENANCE", "INSURANCE", "OTHER"].map(k => <option key={k} value={k}>{names[k]}</option>)}</select></label>
        <label>Date d’achat ({timeZone})<input name="date" className={field} type="date" defaultValue={edit?companyDate(edit.occurredAt):today} required /></label>
        <label>Montant exact<input name="amount" className={field} inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" defaultValue={edit?.amount} placeholder="Ex. 85,40" required /></label>
        <label>Devise explicitement confirmée<input name="currency" className={field} pattern="[A-Z]{3}" defaultValue={edit?.currency ?? currency} required /></label>
        <label>Litres achetés (carburant uniquement)<input name="litres" className={field} inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,3})?" defaultValue={edit?.litres ?? ""} /></label>
        <label>Compteur observé, facultatif<input name="mileage" className={field} type="number" min={0} max={9999999} defaultValue={edit?.mileageObservation ?? ""} /></label>
        <label>Fournisseur<input name="supplier" className={field} maxLength={200} defaultValue={edit?.supplier ?? ""} /></label><label>Référence de facture<input name="reference" className={field} maxLength={200} defaultValue={edit?.reference ?? ""} /></label>
        <label>Justificatif privé<select name="documentVersionId" className={field} defaultValue={edit?.documentVersionId??""}><option value="">Aucun justificatif</option>{edit?.documentVersionId&&!documents.some(d=>!d.archivedAt&&d.currentVersion?.id===edit.documentVersionId)&&<option value={edit.documentVersionId}>Justificatif déjà lié — version historique conservée</option>}{documents.filter(d=>d.currentVersion&&!d.archivedAt).map(d=><option key={d.id} value={d.currentVersion!.id}>{d.title} — version {d.currentVersion!.versionNumber}</option>)}</select>{documentError&&<span role="status">{documentError}</span>}{documentLoading&&<span role="status">Chargement des justificatifs...</span>}{!documentLoading&&!documentError&&!documents.some(d=>d.currentVersion&&!d.archivedAt)&&<span>Aucun justificatif disponible. Ajoutez un ticket ou une facture dans Documents.</span>}</label>
        <label>Intervention d’entretien liée<select name="maintenanceEntryId" className={field} defaultValue={edit?.maintenanceEntryId??""}><option value="">Aucune intervention</option>{edit?.maintenanceEntryId&&!maintenance.some(m=>m.id===edit.maintenanceEntryId)&&<option value={edit.maintenanceEntryId}>Intervention déjà liée — historique conservé</option>}{maintenance.map(m=><option key={m.id} value={m.id}>{m.kind==="OIL_CHANGE"?"Vidange":"Entretien"} — {companyDate(m.occurredAt)} — {m.mileage.toLocaleString("fr-FR")} km</option>)}</select>{maintenanceError&&<span role="status">{maintenanceError}</span>}{maintenanceLoading&&<span role="status">Chargement des interventions...</span>}{!maintenanceLoading&&!maintenanceError&&!maintenance.length&&<span>Aucune intervention enregistrée pour ce véhicule.</span>}</label>
        <label>Notes<textarea name="notes" className={field} maxLength={4000} defaultValue={edit?.notes ?? ""} /></label>
        {edit && <label>Motif de correction<input name="reason" className={field} minLength={3} maxLength={2000} required /></label>}
        <div className="flex gap-2 items-end"><button className={button} disabled={busy}>Enregistrer pour validation</button>{edit && <button type="button" className={button} onClick={() => setEdit(null)}>Abandonner la correction</button>}</div>
      </form>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Registre et rapprochements</h2><p>Une note de frais liée doit rester approuvée et identique à la version rapprochée. Le registre est la seule source de ces indicateurs.</p>
      {expenses.map(e => <article key={e.id} className="border rounded p-3 space-y-2"><h3>{names[e.category]} · {e.amount} {e.currency} · {companyDate(e.occurredAt)}</h3><p>{names[e.status]} · révision {e.revision} · {e.supplier} {e.reference}</p>{e.sourceWarning && <p role="alert">Note source modifiée, non approuvée ou supprimée : exclue jusqu'au rapprochement.</p>}{e.duplicateCandidates.length > 0 && <p role="alert">Doublon possible : {e.duplicateCandidates.map(d => d.label).join(", ")}. Vérifiez avant admission ; annulez la saisie en double.</p>}
        <ul>{e.allocations.map(a=><li key={a.id}>{a.label} : {a.amount} {e.currency}</li>)}</ul>{e.status !== "CANCELLED" && <div className="flex gap-2"><button className={button} onClick={() => setEdit(e)}>Corriger</button><button className={button} onClick={() => { setTarget(e); setReason(""); setSource(e.sourceExpenseReportId ?? ""); setAllocated(""); setTrip("") }}>Valider / rapprocher / imputer</button></div>}
      </article>)}
      {offset != null && <button className={button} disabled={busy} onClick={async () => { try { const r = await fetch(`${base}/expenses?offset=${offset}`, { cache: "no-store" }); if (!r.ok) throw new Error("Chargement refusé"); const d = await r.json(); setExpenses(previous => [...previous, ...d.expenses]); setOffset(d.nextOffset) } catch (e) { setError(e instanceof Error ? e.message : "Erreur réseau") } }}>Afficher les suivantes</button>}
      {target && <form onSubmit={submitAction} className="border rounded p-4 space-y-3"><h3>Action : {names[target.category]} · {target.amount} {target.currency} · {companyDate(target.occurredAt)}</h3><label>Action<select className={field} value={action} onChange={e => setAction(e.target.value)}>{[["APPROVE", "Admettre après vérification des doublons"], ["REJECT", "Refuser"], ["CANCEL", "Annuler"], ["RECONCILE", "Rapprocher une note de frais"], ["ALLOCATE", "Remplacer les imputations"]].map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label>Motif obligatoire<input className={field} value={reason} onChange={e => setReason(e.target.value)} minLength={3} maxLength={2000} required /></label>
        {action === "RECONCILE" && <><label>Note de frais source<select className={field} value={source} onChange={e=>setSource(e.target.value)} required><option value="">Choisir une note de frais</option>{source&&!sourceCandidates.some(s=>s.id===source)&&<option value={source}>Note déjà liée, plus ancienne que la liste récente</option>}{sourceCandidates.map(s=><option key={s.id} value={s.id}>{companyDate(s.date)} · {s.amount} · {names[s.status]??"À vérifier"} · {s.description.slice(0,100)}</option>)}</select></label><p>Je confirme le montant exact {target.amount} et la devise {target.currency} de cette source. Le rapprochement exige ensuite une approbation distincte.</p></>}
        {action === "ALLOCATE" && <><p>Cette commande remplace toutes les imputations par une seule. Laissez le montant vide pour les retirer. Elles ne s'ajoutent jamais au total du registre.</p><label>Trajet, facultatif<select className={field} value={trip} onChange={e=>setTrip(e.target.value)}><option value="">Véhicule, sans trajet précis</option>{tripCandidates.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label><label>Montant imputé, maximum {target.amount} {target.currency}<input className={field} value={allocated} onChange={e => setAllocated(e.target.value)} pattern="[0-9]+([.,][0-9]{1,2})?" /></label></>}
        <button className={button} disabled={busy}>Confirmer l'action</button> <button type="button" className={button} onClick={() => setTarget(null)}>Fermer</button></form>}
    </section>
  </div>
}
