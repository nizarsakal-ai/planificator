"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"

type Employee={id:string;firstName:string;lastName:string}
type Doc={id:string;employeeId:string;title:string;period:string;category:string;status:string;version:number;size:number;canResume?:boolean}
const labels:Record<string,string>={UPLOADING:"Dépôt à reprendre",READY:"À vérifier",REVIEWED:"Vérifié, à publier",PUBLISHED:"Publié",BLOCKED:"Remise suspendue"}
const categories:Record<string,string>={PAYSLIP:"Bulletin de paie",CONTRACT:"Contrat",AMENDMENT:"Avenant",OTHER:"Autre document RH"}
const control="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"
async function call(url:string,init?:RequestInit){
  const response=await fetch(url,{...init,cache:"no-store"});const data=await response.json()
  if(!response.ok)throw new Error(data.error??"Opération indisponible.")
  return data
}
export function Documents({manage=false,configure=false,canImport=false,canPublish=false,mailEnabled=false,employeeId}:{manage?:boolean;configure?:boolean;canImport?:boolean;canPublish?:boolean;mailEnabled?:boolean;employeeId?:string}){
  const [docs,setDocs]=useState<Doc[]>([]),[employees,setEmployees]=useState<Employee[]>([])
  const [error,setError]=useState(""),[message,setMessage]=useState(""),[loading,setLoading]=useState(true)
  const [cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false)
  const [year,setYear]=useState(""),[kind,setKind]=useState("")
  const [importOpen,setImportOpen]=useState(false)
  const load=useCallback(async(append=false,next?:string)=>{
    setLoading(true)
    try{
      const data=await call(`/api/hr-documents?manage=${manage}${employeeId?`&employeeId=${encodeURIComponent(employeeId)}`:""}${next?`&cursor=${encodeURIComponent(next)}`:""}`)
      setDocs(old=>append?[...old,...data.documents]:data.documents);setCursor(data.nextCursor)
      if(manage){const list=await call("/api/hr-documents/employees");setEmployees(employeeId?list.employees.filter((e:Employee)=>e.id===employeeId):list.employees)}
    }catch(e){setError(e instanceof Error?e.message:"Service indisponible.")}finally{setLoading(false)}
  },[manage,employeeId])
  useEffect(()=>{void load()},[load])
  async function action(fn:()=>Promise<unknown>,success:string){
    setBusy(true);setError("");setMessage("")
    try{
      const result=await fn()
      const notice=result&&typeof result==="object"&&"notification" in result?result.notification:null
      const suffix=notice==="UNKNOWN"?" Statut email incertain : rapprochement requis, aucun renvoi automatique.":notice==="PROCESSING"?" Email en cours de traitement, ne pas renvoyer.":notice==="DISABLED"?" Les emails sont désactivés pour ce module.":""
      setMessage(success+suffix);await load()
    }catch(e){setError(e instanceof Error?e.message:"Opération indisponible.")}finally{setBusy(false)}
  }
  const shown=docs.filter(d=>(!year||d.period.startsWith(year))&&(!kind||d.category===kind))
  const selectedEmployee=employeeId?employees.find(e=>e.id===employeeId):undefined
  return <section className="mx-auto max-w-5xl space-y-5">
    {manage&&<nav aria-label="Parcours RH" className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">{[["/employes","Personnel"],["/absences","Absences"],["/pointages","Pointages"],["/notes-de-frais","Notes de frais"],["/rh/documents","Documents RH"]].map(([href,label])=><Link key={href} href={href} aria-current={href==="/rh/documents"?"page":undefined} className={`rounded-lg px-3 py-2 text-sm ${href==="/rh/documents"?"bg-blue-50 font-semibold text-blue-900":"text-slate-600 hover:bg-slate-50"}`}>{label}</Link>)}</nav>}
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold text-slate-900">{manage?(employeeId?`Documents RH — ${selectedEmployee?`${selectedEmployee.firstName} ${selectedEmployee.lastName}`:"salarié sélectionné"}`:"Documents RH"):"Mes documents"}</h1>
      <p className="mt-2 text-sm text-slate-600">{manage?"Les informations du salarié proviennent de sa fiche. Vérifiez le PDF avant chaque publication.":"Vos documents personnels, classés par période. Aucun document d’un autre salarié n’est accessible."}</p></div>{manage&&canImport&&<button type="button" className="rounded-lg bg-blue-800 px-4 py-2 text-sm text-white" onClick={()=>setImportOpen(v=>!v)}>{importOpen?"Fermer le dépôt":"Ajouter des documents"}</button>}</header>
    {manage&&employeeId&&<div className="flex flex-wrap gap-4 text-sm text-blue-900"><Link className="underline" href={`/employes/${encodeURIComponent(employeeId)}`}>Retour à la fiche employé</Link><Link className="underline" href="/rh/documents">Tous les documents RH</Link></div>}
    <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">Copies documentaires privées. Le circuit officiel de remise des bulletins reste inchangé jusqu’à qualification du service.</p>
    {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error} <button type="button" className="underline" onClick={()=>void load()}>Actualiser</button></p>}
    {message&&<p role="status" className="rounded-lg bg-green-50 p-3 text-green-900">{message}</p>}
    {manage&&configure&&<details className="rounded-xl border bg-white p-4"><summary className="cursor-pointer text-sm font-medium text-slate-600">Stockage privé dédié</summary><p className="my-2 text-sm text-slate-600">L’initialisation crée uniquement la racine RH privée dans le compte explicitement configuré. Elle ne déplace aucun document et ne change aucun partage existant.</p><div className="flex flex-wrap gap-3"><button disabled={busy} type="button" className="rounded-lg bg-slate-800 px-4 py-2 text-white disabled:opacity-50" onClick={()=>void action(()=>call("/api/hr-documents/storage",{method:"POST"}),"Racine privée vérifiée.")}>Initialiser ou vérifier le stockage RH</button><button disabled={busy} type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={()=>void action(()=>call("/api/hr-documents/storage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"REASSOCIATE"})}),"Racine réassociée après contrôle du même compte et des droits privés.")}>Réassocier après reconnexion du même compte</button></div></details>}
    {manage&&canImport&&importOpen&&<ImportPanel employees={employees} employeeId={employeeId} busy={busy} run={action}/>}
    <div className="rounded-xl border bg-white p-4">
      <div className="flex flex-wrap items-end gap-3"><label className="min-w-32 text-sm">Année chargée<input className={control} inputMode="numeric" maxLength={4} placeholder="Toutes" value={year} onChange={e=>setYear(e.target.value.replace(/\D/g,""))}/></label>
        <label className="min-w-48 text-sm">Catégorie<select className={control} value={kind} onChange={e=>setKind(e.target.value)}><option value="">Toutes</option>{Object.entries(categories).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <button type="button" className="rounded-lg border px-3 py-2 text-sm" disabled={loading} onClick={()=>void load()}>Actualiser la liste</button></div>
      <p className="my-3 text-xs text-slate-500">Filtres appliqués uniquement aux pages déjà chargées. Utilisez « Charger la suite » pour parcourir les autres documents.</p>
      {loading&&<p role="status">Chargement…</p>}
      {!loading&&!shown.length&&<p className="py-6 text-slate-600">Aucun document dans cette sélection.</p>}
      <ul className="space-y-4">{shown.map(doc=><li key={doc.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap justify-between gap-2"><div className="min-w-0"><h2 className="break-words font-semibold">{doc.title}</h2><p className="text-sm text-slate-600">{categories[doc.category]} · {doc.period} · {Math.ceil(doc.size/1024)} Ko</p>{manage&&<p className="text-sm font-medium text-blue-950">Destinataire : {employees.find(e=>e.id===doc.employeeId)?.lastName??"identifiant interne"} {employees.find(e=>e.id===doc.employeeId)?.firstName??doc.employeeId}</p>}</div><span className="h-fit rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-900">{labels[doc.status]}</span></div>
        <div className="mt-3 flex flex-wrap gap-3">{["READY","REVIEWED","PUBLISHED"].includes(doc.status)&&<a className="rounded-lg border border-blue-200 px-3 py-2 text-sm text-blue-900" href={`/api/hr-documents/${doc.id}/download`}>Télécharger le PDF{manage?" à vérifier":""}</a>}
          {manage&&canPublish&&doc.status==="REVIEWED"&&<PublishButton key={`${doc.id}:${doc.version}`} doc={doc} busy={busy} run={action}/>}
          {manage&&canImport&&doc.status==="REVIEWED"&&<button disabled={busy} type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={()=>void action(()=>call(`/api/hr-documents/${doc.id}/edit`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:doc.version,key:crypto.randomUUID()})}),"La validation a été retirée. Corrigez puis vérifiez à nouveau.")}>Corriger l’affectation avant publication</button>}
          {manage&&canPublish&&mailEnabled&&doc.status==="PUBLISHED"&&<button type="button" disabled={busy} className="rounded-lg border px-3 py-2 text-sm" onClick={()=>void action(()=>call(`/api/hr-documents/${doc.id}/notify`,{method:"POST"}),"Notification traitée. Aucun renvoi si elle était déjà envoyée.")}>Notifier la disponibilité par email</button>}
        </div>
        {manage&&canImport&&doc.status==="READY"&&<ReviewForm key={`${doc.id}:${doc.version}`} doc={doc} employees={employees} busy={busy} run={action}/>}
        {doc.status==="UPLOADING"&&manage&&canImport&&doc.canResume&&<RecoveryForm key={`${doc.id}:${doc.version}`} doc={doc} action="RESUME" busy={busy} run={action}/>}
        {doc.status==="BLOCKED"&&<div className="mt-2 space-y-3"><p className="text-sm text-red-800">L’intégrité ou les accès Drive doivent être revérifiés par une personne RH habilitée.</p>{manage&&canImport&&<><button disabled={busy} type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={()=>void action(()=>call(`/api/hr-documents/${doc.id}/recover`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"REVERIFY",expectedVersion:doc.version})}),"Intégrité et droits revérifiés. Revue et publication à refaire.")}>Revérifier après réparation des accès</button><RecoveryForm key={`${doc.id}:${doc.version}`} doc={doc} action="RESTORE" busy={busy} run={action}/></>}</div>}
      </li>)}</ul>
      {cursor&&<button type="button" className="mt-4 rounded-lg border px-4 py-2" disabled={loading} onClick={()=>void load(true,cursor)}>Charger la suite</button>}
    </div>
  </section>
}
type Runner=(fn:()=>Promise<unknown>,success:string)=>Promise<void>
function PublishButton({doc,busy,run}:{doc:Doc;busy:boolean;run:Runner}){
  const key=useRef<string|undefined>(undefined)
  return <button type="button" disabled={busy} className="rounded-lg bg-blue-800 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={()=>{key.current??=crypto.randomUUID();void run(()=>call(`/api/hr-documents/${doc.id}/publish`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:doc.version,key:key.current})}),"Document publié dans l’espace du salarié. La notification reste suivie séparément.")}}>Publier la version vérifiée</button>
}
function ReviewForm({doc,employees,busy,run}:{doc:Doc;employees:Employee[];busy:boolean;run:Runner}){
  return <form className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2" onSubmit={e=>{
    e.preventDefault();const f=new FormData(e.currentTarget)
    const data={employeeId:f.get("employeeId"),category:f.get("category"),period:f.get("period"),title:f.get("title"),key:crypto.randomUUID(),expectedVersion:doc.version}
    void run(()=>call(`/api/hr-documents/${doc.id}/review`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),"Affectation et version vérifiées. Publication séparée requise.")
  }}>
    <MetadataFields employees={employees} defaults={doc}/>
    <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required className="mt-1"/>J’ai vérifié le contenu du PDF, le salarié, la période et la catégorie de cette version.</label>
    <button disabled={busy} className="rounded-lg border border-blue-300 px-4 py-2 text-sm text-blue-900 disabled:opacity-50">Valider cette affectation</button>
  </form>
}
function MetadataFields({employees,defaults}:{employees:Employee[];defaults?:Partial<Doc>}){
  return <><label className="text-sm">Salarié<select required name="employeeId" className={control} defaultValue={defaults?.employeeId??""}><option value="" disabled>Choisir explicitement</option>{employees.map(e=><option key={e.id} value={e.id}>{e.lastName} {e.firstName}</option>)}</select></label>
    <label className="text-sm">Catégorie<select required name="category" className={control} defaultValue={defaults?.category??"PAYSLIP"}>{Object.entries(categories).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label className="text-sm">Période<input required type="month" name="period" className={control} defaultValue={defaults?.period}/></label>
    <label className="text-sm">Titre privé<input required maxLength={120} name="title" className={control} defaultValue={defaults?.title}/></label></>
}
function RecoveryForm({doc,action,busy,run}:{doc:Doc;action:"RESUME"|"RESTORE";busy:boolean;run:Runner}){
  return <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3" onSubmit={e=>{
    e.preventDefault();const form=new FormData(e.currentTarget);form.set("action",action);form.set("expectedVersion",String(doc.version))
    void run(()=>call(`/api/hr-documents/${doc.id}/recover`,{method:"POST",body:form}),"PDF original vérifié. Revue et publication restent nécessaires.")
  }}><label className="min-w-0 text-sm">{action==="RESUME"?"Reprendre avec exactement le PDF réservé":"Restaurer le PDF original, sans changer son destinataire"}<input className="mt-2 block max-w-full" type="file" name="file" accept="application/pdf,.pdf" required disabled={busy}/></label><button disabled={busy} className="rounded-lg border px-3 py-2 text-sm">{action==="RESUME"?"Reprendre ce dépôt":"Restaurer une copie privée"}</button></form>
}
function ImportPanel({employees,employeeId,busy,run}:{employees:Employee[];employeeId?:string;busy:boolean;run:Runner}){
  const [files,setFiles]=useState<{file:File;key:string}[]>([])
  return <div className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Dépôt PDF — unitaire ou lot</h2>
    <p className="my-2 text-sm text-slate-600">10 fichiers au maximum par sélection, 10 Mo par PDF. Chaque affectation est vérifiée séparément. Aucun classement automatique ni publication par l’IA.</p>
    <label className="block text-sm">Choisir les PDF<input type="file" accept="application/pdf,.pdf" multiple disabled={busy} className="mt-2 block max-w-full text-sm" onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,10).map(file=>({file,key:crypto.randomUUID()})))}/></label>
    <div className="space-y-4">{files.map(({file,key})=><form key={key} className="mt-4 grid gap-3 rounded-lg border p-3 sm:grid-cols-2" onSubmit={e=>{
      e.preventDefault();const f=new FormData(e.currentTarget);f.set("key",key);f.set("file",file)
      void run(()=>call("/api/hr-documents",{method:"POST",body:f}),"PDF déposé en préparation. Vérification et publication restent nécessaires.")
    }}><p className="break-all text-sm font-medium sm:col-span-2">{file.name}</p><MetadataFields employees={employees} defaults={employeeId?{employeeId}:undefined}/><button disabled={busy} className="rounded-lg bg-blue-800 px-3 py-2 text-sm text-white disabled:opacity-50">Déposer ce PDF privé</button></form>)}</div>
  </div>
}
