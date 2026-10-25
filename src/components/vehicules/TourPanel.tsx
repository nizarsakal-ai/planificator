"use client";
import { isExplicitSubmit, preventImplicitEnter } from "@/components/vehicules/explicit-submit"
import { VehicleMileagePanel } from "./VehicleMileagePanel";
import { VehicleWorkspaceNav } from "@/components/vehicules/v3/VehicleWorkspaceNav"
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { companyCivilTimeToIso, selectApprovedTourImport } from "@/lib/vehicules/v3/tour-time";
type Stop = DraftStop & {
    id: string;
    position: number;
    label: string;
    address: string;
    completedAt: string | null;
    skippedAt: string | null;
    skippedReason: string | null;
};
type Tour = {
    id: string;
    title: string;
    status: string;
    revision: number;
    startsAt: string;
    endsAt: string;
    estimatedKm: number | null;
    actualKm: number | null;
    stops: Stop[];
};
type DraftStop = {
    label: string;
    address: string;
    worksiteId?: string;
    clientId?: string;
    latitude?: number | null;
    longitude?: number | null;
};
type Data = {
    timezone: string;
    worksites: {
        id: string;
        name: string;
        address: string;
        clientId: string;
        latitude: number | null;
        longitude: number | null;
    }[];
    clients: {
        id: string;
        name: string;
        address: string;
    }[];
    matricule: string;
    teamId: string | null;
    chauffeurId: string | null;
    currentMileage: number | null;
    mileageRevision: number;
    canManage: boolean;
    tours: Tour[];
};
const statuses: Record<string, string> = { PLANNED: "Planifiée", IN_PROGRESS: "En cours", COMPLETED: "Terminée", CANCELLED: "Annulée" };
function civilInput(value:string,timeZone:string){const parts=new Intl.DateTimeFormat("sv-SE",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(value));return parts.replace(" ","T")}
function friendlyError(error: unknown) { const code = error instanceof Error ? error.message : ""; const messages: Record<string, string> = { V3_DISABLED: "Les tournées V3 ne sont pas activées.", FORBIDDEN: "Vous ne disposez pas des droits nécessaires.", UNAUTHENTICATED: "Veuillez vous reconnecter.", TOUR_RESOURCE_CONFLICT: "Le camion, l’équipe ou le chauffeur est déjà réservé sur ce créneau.", DAILY_TEAM_PLANNING_CONFLICT: "Cette tournée est incompatible avec le planning journalier de l’équipe.", DAILY_DRIVER_PLANNING_CONFLICT: "Cette tournée est incompatible avec le planning journalier du chauffeur.", TOUR_ASSIGNMENT_CHANGED: "L’affectation du camion a changé. Vérifiez la tournée.", TOUR_REVISION_CONFLICT: "La tournée a changé. Actualisez la page.", MILEAGE_REVISION_CONFLICT: "Le compteur a changé. Actualisez la page.", INVALID_PAYLOAD: "Vérifiez les dates et les adresses de la tournée.", TOUR_STOPS_PENDING: "Indiquez chaque étape effectuée ou non visitée avant de clôturer.", ARRIVAL_BELOW_DEPARTURE: "Le compteur d’arrivée doit être au moins égal à celui du départ.", TRUCK_ARCHIVED: "Ce véhicule est archivé.", TRIP_ALREADY_OPEN: "Un trajet est déjà en cours pour ce véhicule.", INVALID_CIVIL_TIME: "Vérifiez la date et l’heure saisies.", NONEXISTENT_CIVIL_TIME: "Cette heure n’existe pas dans le fuseau de l’entreprise à cause du changement d’heure. Choisissez un autre horaire.", AMBIGUOUS_CIVIL_TIME: "Cette heure se produit deux fois lors du changement d’heure. Choisissez un autre horaire non ambigu.", IMPORT_UNAVAILABLE: "L’import approuvé n’est plus disponible. Revenez aux imports et vérifiez sa validation." }; return messages[code] || "L’opération n’a pas abouti. Actualisez puis réessayez."; }
export function TourPanel({ truckId, importId, importRevision, importRequested = false }: {
    truckId: string;
    importId?: string;
    importRevision?: number;
    importRequested?: boolean;
}) {
    const [data, setData] = useState<Data | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [show, setShow] = useState(importRequested);
    const [detailsEditing,setDetailsEditing]=useState<Tour|null>(null);
    const [showMileage,setShowMileage] = useState(false);
    const [editing, setEditing] = useState<Tour | null>(null);
    const [draftStops, setDraftStops] = useState<DraftStop[]>([]), [freeAddress, setFreeAddress] = useState("");
    const [approvedImport, setApprovedImport] = useState<ReturnType<typeof selectApprovedTourImport> | null>(null), [importError, setImportError] = useState("");
    useEffect(() => { if (!importRequested)
        return; let cancelled = false; setApprovedImport(null); setImportError(""); if (!importId || !Number.isInteger(importRevision) || !importRevision) {
        setImportError("La référence ou la révision de l’import est invalide.");
        return;
    } void (async () => { try {
        const r = await fetch(`/api/trucks/${encodeURIComponent(truckId)}/address-imports`, { cache: "no-store" });
        if (!r.ok)
            throw new Error("IMPORT_UNAVAILABLE");
        const source = selectApprovedTourImport(await r.json(), importId, importRevision);
        if (!cancelled)
            setApprovedImport(source);
    }
    catch {
        if (!cancelled)
            setImportError("Cet import approuvé et sa révision ne sont plus disponibles parmi les 30 derniers imports. Revenez aux imports pour vérifier et valider la source.");
    } })(); return () => { cancelled = true; }; }, [truckId, importId, importRevision, importRequested]);
    const pendingKeys = useRef(new Map<string, string>());
    const url = `/api/trucks/${encodeURIComponent(truckId)}/tours`;
    const load = useCallback(async () => {
        try {
            const r = await fetch(url, { cache: "no-store" });
            const j = await r.json();
            if (!r.ok)
                throw new Error(j.code);
            setData(j);
        }
        catch (e) {
            setError(friendlyError(e));
        }
    }, [url]);
    useEffect(() => { void load(); }, [load]);
    async function send(body: unknown, id?: string) {
        setBusy(true);
        setError("");
        try {
            const signature = JSON.stringify([id, body]);
            let key = pendingKeys.current.get(signature);
            if (!key) {
                key = crypto.randomUUID();
                pendingKeys.current.set(signature, key);
            }
            const r = await fetch(url + (id ? `/${encodeURIComponent(id)}` : ""), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
            const j = await r.json();
            if (!r.ok) {
                if (r.status < 500)
                    pendingKeys.current.delete(signature);
                throw new Error(j.code);
            }
            pendingKeys.current.delete(signature);
            await load();
            setShow(false);
            setEditing(null);
            setDetailsEditing(null);
            return true;
        }
        catch (e) {
            setError(friendlyError(e));
            return false;
        }
        finally {
            setBusy(false);
        }
    }
    async function create(form: FormData):Promise<boolean> {
        if (!data)
            return false;
        try {
            if (!editing && importRequested && (!approvedImport || importError))
                throw new Error("IMPORT_UNAVAILABLE");
            const created = editing ? await send({ type: "EDIT", expectedRevision: editing.revision, title: form.get("title"), startsAt: companyCivilTimeToIso(String(form.get("start")), data.timezone), endsAt: companyCivilTimeToIso(String(form.get("end")), data.timezone), estimatedKm: form.get("km") ? Number(form.get("km")) : null, stops: draftStops.map(s => ({...s,addressValidated:true})), reason: form.get("reason") }, editing.id) : await send({ title: form.get("title"), startsAt: companyCivilTimeToIso(String(form.get("start")), data.timezone), endsAt: companyCivilTimeToIso(String(form.get("end")), data.timezone), teamId: data.teamId, chauffeurId: data.chauffeurId, estimatedKm: form.get("km") ? Number(form.get("km")) : null, ...(importRequested ? { approvedImportId: approvedImport!.id, approvedImportRevision: approvedImport!.revision, stops: [] } : { stops: draftStops.map(s => ({ ...s, addressValidated: true })) }) });
            if (created) { setDraftStops([]); setFreeAddress(""); }
            if (created && !editing && importRequested) {
                setApprovedImport(null);
                setImportError("Cet import a été utilisé pour la tournée. Revenez aux imports pour préparer une autre source.");
            }
            return created;
        }
        catch (e) {
            setError(friendlyError(e));
            return false;
        }
    }
    return <main className="mx-auto max-w-4xl space-y-6 p-6"><VehicleWorkspaceNav truckId={truckId} active="tournees" canManage={data?.canManage ?? false} /><h1 className="text-2xl font-bold">Tournées {data?.matricule}</h1>{error && <p role="alert" className="text-red-700">{error}</p>}{!data && !error && <p>Chargement…</p>}{data?.canManage && <button disabled={busy} type="button" onClick={() => {setEditing(null);setDraftStops([]);setFreeAddress("");setShow(!show)}}>Préparer une tournée</button>}{show && data?.canManage && <form onKeyDown={preventImplicitEnter} key={editing?.id ?? "new"} onSubmit={event=>{if(!isExplicitSubmit(event))return;const form=event.currentTarget;void create(new FormData(form)).then(ok=>{if(ok)form.reset()})}} className="grid gap-3 rounded border p-4"><label>Nom<input className="block border" name="title" defaultValue={editing?.title} required maxLength={200}/></label><p>Horaires de l’entreprise : {data?.timezone}.</p><label>Début<input className="block border" name="start" type="datetime-local" defaultValue={editing ? civilInput(editing.startsAt, data!.timezone) : undefined} required/></label><label>Fin<input className="block border" name="end" type="datetime-local" defaultValue={editing ? civilInput(editing.endsAt, data!.timezone) : undefined} required/></label><p>Équipe et chauffeur : affectation actuelle du camion. Le départ vérifiera qu’elle est toujours identique.</p>{!editing && importRequested ? <section aria-label="Adresses importées approuvées"><h2>Adresses de l’import approuvé — lecture seule</h2>{importError ? <p role="alert">{importError}</p> : approvedImport ? <ol className="list-inside list-decimal">{approvedImport.candidates.map((s, i) => <li key={i}>{s.label} — {s.address}</li>)}</ol> : <p>Vérification de l’import…</p>}<Link href={`/vehicules/${encodeURIComponent(truckId)}/imports`}>Revenir aux imports</Link></section> : <><label>Ajouter un chantier existant (200 premiers)<select className="block border" value="" onChange={e => {
                    const s = data?.worksites.find(s => s.id === e.target.value);
                    if (s)
                        setDraftStops([...draftStops, { label: s.name, address: s.address, worksiteId: s.id, clientId: s.clientId, latitude: s.latitude, longitude: s.longitude }]);
                }}><option value="">Choisir…</option>{data?.worksites.map(s => <option key={s.id} value={s.id}>{s.name} — {s.address}</option>)}</select></label><label>Ajouter une adresse client (200 premiers)<select className="block border" value="" onChange={e => {
                    const c = data?.clients.find(c => c.id === e.target.value);
                    if (c)
                        setDraftStops([...draftStops, { label: c.name, address: c.address, clientId: c.id }]);
                }}><option value="">Choisir…</option>{data?.clients.map(c => <option key={c.id} value={c.id}>{c.name} — {c.address}</option>)}</select></label><label>Adresse libre<input className="block w-full border" value={freeAddress} onChange={e => setFreeAddress(e.target.value)}/></label><button type="button" disabled={freeAddress.trim().length < 5 || draftStops.length >= 50} onClick={() => { setDraftStops([...draftStops, { label: `Étape ${draftStops.length + 1}`, address: freeAddress.trim() }]); setFreeAddress(""); }}>Ajouter cette adresse</button><ol>{draftStops.map((s, i) => <li key={i}>{i + 1}. <label>Libellé de l’étape<input value={s.label} onChange={e=>setDraftStops(items=>items.map((item,n)=>n===i?{...item,label:e.target.value}:item))}/></label><label>Adresse de l’étape<input value={s.address} minLength={5} required onChange={e=>setDraftStops(items=>items.map((item,n)=>n===i?{...item,address:e.target.value,latitude:null,longitude:null,worksiteId:undefined,clientId:undefined}:item))}/></label> <button type="button" disabled={i === 0} aria-label={`Monter étape ${i + 1}`} onClick={() => { const next = [...draftStops]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; setDraftStops(next); }}>↑</button><button type="button" aria-label={`Retirer étape ${i + 1}`} onClick={() => setDraftStops(draftStops.filter((_, n) => n !== i))}>Retirer</button></li>)}</ol></>}<label><input type="checkbox" required/> J’ai vérifié chaque adresse et l’ordre des étapes.</label><label>Estimation manuelle (km)<input className="block border" name="km" type="number" min="0" max="100000" step="0.1" defaultValue={editing?.estimatedKm ?? undefined}/></label>{editing && <label>Motif de modification<input name="reason" required minLength={3} maxLength={2000}/></label>}<button data-explicit-submit="true" type="submit" disabled={busy || (!editing && importRequested ? !approvedImport || !!importError : draftStops.length === 0 || draftStops.length > 50)}>Valider les informations</button><button type="button" disabled={busy} onClick={()=>{setShow(false);setEditing(null);setDraftStops([])}}>Annuler les modifications</button></form>}{data?.tours.length === 0 && <p>Aucune tournée.</p>}{data?.tours.map(t => <article key={t.id} className="space-y-3 rounded border p-4"><h2 className="text-lg font-semibold">{t.title} — {statuses[t.status]}</h2><p>{new Date(t.startsAt).toLocaleString("fr-FR", { timeZone: data.timezone })} → {new Date(t.endsAt).toLocaleString("fr-FR", { timeZone: data.timezone })} ({data.timezone})</p><p>Distance réelle : {t.actualKm === null ? "non disponible" : `${t.actualKm} km`}. Estimation manuelle : {t.estimatedKm === null ? "non renseignée" : `${t.estimatedKm} km`}.</p><ol className="list-inside list-decimal">{t.stops.map(s => <li key={s.id}>{s.label} : {s.address} {s.completedAt ? "✓ Effectuée" : s.skippedAt ? `Non visitée : ${s.skippedReason}` : t.status === "IN_PROGRESS" && t.stops.find(x => !x.completedAt && !x.skippedAt)?.id === s.id ? <><button disabled={busy} onClick={() => send({ type: "STOP", expectedRevision: t.revision, stopId: s.id }, t.id)}>Marquer effectuée</button><form onKeyDown={preventImplicitEnter} className="mt-2" onSubmit={event => { if(!isExplicitSubmit(event))return; const form = new FormData(event.currentTarget); void send({ type: "SKIP", expectedRevision: t.revision, stopId: s.id, reason: String(form.get("reason") || "").trim() }, t.id); }}><label>Motif de non-visite<input name="reason" required minLength={1} maxLength={2000} className="mx-2 border" /></label><button data-explicit-submit="true" type="submit" disabled={busy}>Signaler non visitée</button></form></> : null}</li>)}</ol>{(t.status === "PLANNED" || t.status === "IN_PROGRESS") && <form onKeyDown={preventImplicitEnter} onSubmit={event=>{if(!isExplicitSubmit(event))return;const form=new FormData(event.currentTarget);void send({ type: t.status === "PLANNED" ? "START" : "COMPLETE", expectedRevision: t.revision, expectedMileageRevision: data.mileageRevision, mileage: Number(form.get("mileage")) },t.id)}}><label>Compteur {t.status === "PLANNED" ? "au départ" : "à l’arrivée"}<input className="mx-2 border" type="number" name="mileage" min="0" max="9999999" required defaultValue={data.currentMileage ?? undefined}/></label><button data-explicit-submit="true" type="submit" disabled={busy || t.status === "IN_PROGRESS" && t.stops.some(s => !s.completedAt && !s.skippedAt)}>{t.status === "PLANNED" ? "Démarrer" : "Clôturer"}</button></form>}{t.status === "PLANNED" && data.canManage && <button type="button" disabled={busy} onClick={()=>{setEditing(t);setDraftStops(t.stops.map(s=>({label:s.label,address:s.address,worksiteId:s.worksiteId,clientId:s.clientId,latitude:s.latitude,longitude:s.longitude})));setShow(true)}}>Modifier</button>}{t.status !== "PLANNED" && data.canManage && <><button type="button" disabled={busy} onClick={()=>setDetailsEditing(t)}>Modifier les informations</button><button type="button" disabled={busy} onClick={()=>setShowMileage(true)}>Modifier les relevés kilométriques</button></>}{detailsEditing?.id===t.id&&data.canManage&&<form key={`details-${t.id}-${t.revision}`} onKeyDown={preventImplicitEnter} className="grid gap-3 rounded border p-4" onSubmit={event=>{if(!isExplicitSubmit(event))return;const form=new FormData(event.currentTarget);void send({type:"DETAILS",expectedRevision:detailsEditing.revision,title:form.get("title"),estimatedKm:form.get("km")?Number(form.get("km")):null,reason:form.get("reason")},t.id)}}><h3>Modifier les informations de la tournée</h3><p>Les horaires, étapes et relevés déjà enregistrés sont conservés.</p><label>Nom<input name="title" required maxLength={200} defaultValue={detailsEditing.title}/></label><label>Estimation manuelle (km)<input name="km" type="number" min={0} max={100000} step="0.1" defaultValue={detailsEditing.estimatedKm??undefined}/></label><label>Motif de modification<input name="reason" required minLength={3} maxLength={2000}/></label><button type="submit" data-explicit-submit="true" disabled={busy}>Valider les modifications</button><button type="button" disabled={busy} onClick={()=>setDetailsEditing(null)}>Annuler les modifications</button></form>}{t.status === "PLANNED" && data.canManage && <button disabled={busy} onClick={() => send({ type: "CANCEL", expectedRevision: t.revision }, t.id)}>Annuler la tournée</button>}</article>)}{showMileage&&data?.canManage&&<section className="border rounded p-4"><h2>Modifier les relevés — historique conservé</h2><p>Les étapes effectuées restent tracées. Une correction du relevé recalcule la distance réelle de la tournée.</p><VehicleMileagePanel truckId={truckId} matricule={data.matricule} active={true} canManage={data.canManage} initialMileage={data.currentMileage} onMileageChanged={()=>void load()}/><button type="button" onClick={()=>setShowMileage(false)}>Fermer</button></section>}</main>;
}
