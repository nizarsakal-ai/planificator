"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Download, Eye, FileText, LockKeyhole } from "lucide-react"
import { DocumentFolders } from "./DocumentFolders"
import { availableCategories, categoryLabel, type CategoryDefinition } from "@/lib/hr-documents/catalog"
import { fetchHrDocument } from "@/lib/hr-documents/download-client"
import { DocumentPreview, saveBlob, type PreviewTarget } from "./DocumentPreview"

type Employee={id:string;firstName:string;lastName:string;draft?:boolean}
type Category=Pick<CategoryDefinition,"code"|"label"|"family">
type Doc={id:string;employeeId:string;title:string;period:string;category:string;status:string;version:number;size:number;canResume?:boolean}
const labels:Record<string,string>={UPLOADING:"Dépôt à reprendre",READY:"À vérifier",REVIEWED:"Vérifié, à publier",PUBLISHED:"Publié",BLOCKED:"Remise suspendue",RECEIVING:"Dépôt du salarié en cours",RECEIVED:"Reçu du salarié, à vérifier"}
// Codes historiques par défaut ; la page passe le catalogue autorisé par les drapeaux (PLV2-DOC-RH-002).
const LEGACY:Category[]=availableCategories({} as NodeJS.ProcessEnv).map(({code,label,family})=>({code,label,family}))
const control="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"
async function call(url:string,init?:RequestInit){
  // Coupure réseau ou réponse non JSON (page de connexion, erreur d'un proxy) : message lisible, jamais l'erreur brute du navigateur.
  let response:Response
  try{response=await fetch(url,{...init,cache:"no-store"})}catch{throw new Error("Connexion au serveur impossible. Réessayez.")}
  const data=await response.json().catch(()=>null)
  if(!response.ok||response.redirected||!data)throw new Error(typeof data?.error==="string"&&data.error?data.error:"Opération indisponible.")
  return data
}
/** Téléchargement par fetch : seule une réponse document validée est enregistrée ; sinon le message s'affiche dans la page. */
async function downloadDocument(id:string){
  const {blob,name}=await fetchHrDocument(id)
  saveBlob(blob,name)
}
export function Documents({manage=false,configure=false,canImport=false,canPublish=false,mailEnabled=false,employeeId,employeeContext,canReturnToEmployee=false,categories=LEGACY,recognition=false,images=false,drafts=false}:{manage?:boolean;configure?:boolean;canImport?:boolean;canPublish?:boolean;mailEnabled?:boolean;employeeId?:string;employeeContext?:Employee;canReturnToEmployee?:boolean;categories?:Category[];recognition?:boolean;images?:boolean;drafts?:boolean}){
  const [docs,setDocs]=useState<Doc[]>([]),[employees,setEmployees]=useState<Employee[]>([])
  const [error,setError]=useState(""),[message,setMessage]=useState(""),[loading,setLoading]=useState(true)
  const [cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false)
  const [year,setYear]=useState(""),[kind,setKind]=useState("")
  const [importOpen,setImportOpen]=useState(false)
  const [employeeChoice,setEmployeeChoice]=useState("")
  const [preview,setPreview]=useState<PreviewTarget|null>(null),previewTrigger=useRef<HTMLButtonElement|null>(null)
  const loadVersion=useRef(0)
  const load=useCallback(async(append=false,next?:string)=>{
    const version=++loadVersion.current
    setLoading(true);setError("")
    try{
      const data=await call(`/api/hr-documents?manage=${manage}${employeeId?`&employeeId=${encodeURIComponent(employeeId)}`:""}${next?`&cursor=${encodeURIComponent(next)}`:""}`)
      let people:Employee[]=[]
      if(manage&&employeeContext)people=[employeeContext]
      else if(manage){const list=await call("/api/hr-documents/employees");people=employeeId?list.employees.filter((e:Employee)=>e.id===employeeId):list.employees}
      if(version!==loadVersion.current)return
      setDocs(old=>append?[...old,...data.documents]:data.documents);setCursor(data.nextCursor);setEmployees(people)
    }catch(e){if(version===loadVersion.current){setDocs([]);setEmployees([]);setCursor(null);setError(e instanceof Error?e.message:"Service indisponible.")}}finally{if(version===loadVersion.current)setLoading(false)}
  },[manage,employeeId,employeeContext])
  useEffect(()=>{void load();return()=>{loadVersion.current++}},[load])
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
  const selectedEmployee=employeeId?(employeeContext??employees.find(e=>e.id===employeeId)):undefined
  const employeeFolder = manage && !!employeeId
  const renderDoc = (doc: Doc, month?: string) => {
    const review = manage&&canImport&&doc.status==="READY"
      ? <ReviewForm key={`${doc.id}:${doc.version}`} doc={doc} employees={employees} categories={categories} busy={busy} run={action}/>
      : null
    const viewable = ["READY","REVIEWED","PUBLISHED"].includes(doc.status)
    const iconButton = "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-blue-950 hover:bg-blue-50 focus-visible:outline focus-visible:outline-2"
    return <li key={doc.id} className={employeeFolder?"px-3 py-3":"rounded-xl border border-slate-200 p-4"}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="flex items-start gap-2 break-words text-sm font-semibold text-slate-900"><FileText size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-blue-950"/>{month??doc.title}</h4>
            {month&&doc.title!==categoryLabel(doc.category)&&<p className="ml-6 break-words text-xs text-slate-600">{doc.title}</p>}
            {(!employeeFolder||doc.status!=="PUBLISHED")&&<p className="ml-6 text-xs text-slate-600">{categoryLabel(doc.category)} · {doc.period} · {labels[doc.status]}{!employeeFolder&&` · ${Math.ceil(doc.size/1024)} Ko`}</p>}
            {manage&&!employeeFolder&&<p className="ml-6 text-sm font-medium text-blue-950">Destinataire : {employees.find(e=>e.id===doc.employeeId)?.lastName??"identifiant interne"} {employees.find(e=>e.id===doc.employeeId)?.firstName??doc.employeeId}</p>}
          </div>
          {viewable&&<div className="flex shrink-0 gap-0.5">
            <button type="button" className={iconButton} title="Visualiser" aria-haspopup="dialog" onClick={e=>{previewTrigger.current=e.currentTarget;setError("");setPreview(old=>old?.id===doc.id?old:{id:doc.id,title:doc.title})}}>
              <Eye size={17} aria-hidden="true"/><span className="sr-only">Visualiser</span></button>
            <button type="button" className={iconButton} title="Télécharger" onClick={()=>{setError("");void downloadDocument(doc.id).catch(e=>setError(e instanceof Error?e.message:"Téléchargement indisponible."))}}>
              <Download size={17} aria-hidden="true"/><span className="sr-only">Télécharger</span></button>
          </div>}
        </div>
        <div className="flex flex-wrap gap-3 empty:hidden [&:not(:empty)]:mt-2">
          {manage&&canPublish&&doc.status==="REVIEWED"&&<PublishButton key={`${doc.id}:${doc.version}`} doc={doc} busy={busy} run={action}/>}
          {manage&&canImport&&doc.status==="REVIEWED"&&<button disabled={busy} type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={()=>void action(()=>call(`/api/hr-documents/${doc.id}/edit`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:doc.version,key:crypto.randomUUID()})}),"La validation a été retirée. Corrigez puis vérifiez à nouveau.")}>Corriger l’affectation avant publication</button>}
          {manage&&canPublish&&mailEnabled&&doc.status==="PUBLISHED"&&<button type="button" disabled={busy} className="rounded-lg border px-3 py-2 text-sm" onClick={()=>void action(()=>call(`/api/hr-documents/${doc.id}/notify`,{method:"POST"}),"Notification traitée. Aucun renvoi si elle était déjà envoyée.")}>Notifier la disponibilité par email</button>}
        </div>
        {review && (employeeFolder ? <details className="mt-2"><summary className="cursor-pointer text-sm text-blue-900">Vérifier l’affectation</summary>{review}</details> : review)}
        {doc.status==="UPLOADING"&&manage&&canImport&&doc.canResume&&<RecoveryForm key={`${doc.id}:${doc.version}`} doc={doc} action="RESUME" busy={busy} run={action}/>}
        {doc.status==="BLOCKED"&&<div className="mt-2 space-y-3"><p className="text-sm text-red-800">L’intégrité ou les accès Drive doivent être revérifiés par une personne RH habilitée.</p>{manage&&canImport&&<><button disabled={busy} type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={()=>void action(()=>call(`/api/hr-documents/${doc.id}/recover`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"REVERIFY",expectedVersion:doc.version})}),"Intégrité et droits revérifiés. Revue et publication à refaire.")}>Revérifier après réparation des accès</button><RecoveryForm key={`${doc.id}:${doc.version}`} doc={doc} action="RESTORE" busy={busy} run={action}/></>}</div>}
      </li>
  }
  return <section className={`mx-auto space-y-5 ${employeeFolder?"max-w-7xl":"max-w-5xl"}`}>
    {manage&&<nav aria-label="Parcours RH" className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">{[["/employes","Personnel"],["/absences","Absences"],["/pointages","Pointages"],["/notes-de-frais","Notes de frais"],["/rh/documents","Documents RH"]].map(([href,label])=><Link key={href} href={href} aria-current={href==="/rh/documents"?"page":undefined} className={`rounded-lg px-3 py-2 text-sm ${href==="/rh/documents"?"bg-blue-50 font-semibold text-blue-900":"text-slate-600 hover:bg-slate-50"}`}>{label}</Link>)}</nav>}
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-slate-900">{employeeFolder
      ? `Dossier de ${selectedEmployee ? `${selectedEmployee.firstName} ${selectedEmployee.lastName}`.trim() : "ce salarié"}`
      : manage ? "Documents RH" : "Mes documents"}
      {employeeFolder && <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium"><LockKeyhole size={14} aria-hidden="true"/>Privé</span>}</h1>
      <p className="mt-2 text-sm text-slate-600">{manage?"Les informations du salarié proviennent de sa fiche. Vérifiez le PDF avant chaque publication.":"Vos documents personnels, classés par période. Aucun document d’un autre salarié n’est accessible."}</p></div>{manage&&canImport&&<button type="button" className="rounded-lg bg-blue-800 px-4 py-2 text-sm text-white" disabled={busy} onClick={()=>setImportOpen(v=>!v)}>{importOpen?"Fermer le dépôt":"Ajouter des fichiers"}</button>}</header>
    {manage&&employeeId&&<div className="flex flex-wrap gap-4 text-sm text-blue-900">{canReturnToEmployee&&<Link className="underline" href={`/employes/${encodeURIComponent(employeeId)}`}>Retour à la fiche employé</Link>}<Link className="underline" href="/rh/documents">Tous les documents RH</Link></div>}
    {manage&&!employeeId&&employees.length>0&&<div className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-4">
      <label className="min-w-48 text-sm">Dossier salarié<select className={control} value={employeeChoice} onChange={e=>setEmployeeChoice(e.target.value)}>
        <option value="">Choisir un salarié</option>{employees.filter(e=>!e.draft).map(e=><option key={e.id} value={e.id}>{e.lastName} {e.firstName}</option>)}
      </select></label>
      {employeeChoice&&<Link className="rounded-lg bg-blue-900 px-4 py-2 text-sm text-white" href={`/rh/documents?employeeId=${encodeURIComponent(employeeChoice)}`}>Ouvrir le dossier</Link>}
    </div>}
    <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">Copies documentaires privées. Le circuit officiel de remise des bulletins reste inchangé jusqu’à qualification du service.</p>
    {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error} <button type="button" className="underline" onClick={()=>void load()}>Actualiser</button></p>}
    {message&&<p role="status" className="rounded-lg bg-green-50 p-3 text-green-900">{message}</p>}
    {manage&&configure&&<details className="rounded-xl border bg-white p-4"><summary className="cursor-pointer text-sm font-medium text-slate-600">Stockage privé dédié</summary><p className="my-2 text-sm text-slate-600">L’initialisation crée uniquement la racine RH privée dans le compte explicitement configuré. Elle ne déplace aucun document et ne change aucun partage existant.</p><div className="flex flex-wrap gap-3"><button disabled={busy} type="button" className="rounded-lg bg-slate-800 px-4 py-2 text-white disabled:opacity-50" onClick={()=>void action(()=>call("/api/hr-documents/storage",{method:"POST"}),"Racine privée vérifiée.")}>Initialiser ou vérifier le stockage RH</button><button disabled={busy} type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={()=>void action(()=>call("/api/hr-documents/storage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"REASSOCIATE"})}),"Racine réassociée après contrôle du même compte et des droits privés.")}>Réassocier après reconnexion du même compte</button></div></details>}
    {manage&&canImport&&importOpen&&<ImportPanel employees={employees} employeeId={employeeId} employeeName={selectedEmployee?`${selectedEmployee.firstName} ${selectedEmployee.lastName}`.trim():undefined} busy={busy} run={action} categories={categories} recognition={recognition} images={images} drafts={drafts} onDraft={e=>setEmployees(list=>[...list,e])}/>}
    <div className="rounded-xl border bg-white p-4">
      <div className="flex flex-wrap items-end gap-3"><label className="min-w-32 text-sm">Année chargée<input className={control} inputMode="numeric" maxLength={4} placeholder="Toutes" value={year} onChange={e=>setYear(e.target.value.replace(/\D/g,""))}/></label>
        <label className="min-w-48 text-sm">Catégorie<select className={control} value={kind} onChange={e=>setKind(e.target.value)}><option value="">Toutes</option>{categories.map(c=><option key={c.code} value={c.code}>{c.label}</option>)}</select></label>
        <button type="button" className="rounded-lg border px-3 py-2 text-sm" disabled={loading} onClick={()=>void load()}>Actualiser la liste</button></div>
      <p className="my-3 text-xs text-slate-500">Filtres appliqués uniquement aux pages déjà chargées. Utilisez « Charger la suite » pour parcourir les autres documents.</p>
      {loading&&<p role="status">Chargement…</p>}
      {!loading&&!shown.length&&<p className="py-6 text-slate-600">Aucun document dans cette sélection.</p>}
      {employeeFolder&&cursor&&<p className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Dossier partiellement chargé : les sous-dossiers, les années et leurs compteurs ne montrent que les documents déjà chargés. Utilisez « Charger la suite » en bas de la liste.</p>}
      {employeeFolder ? <DocumentFolders documents={shown} renderDocument={renderDoc}/> : <ul className="space-y-4">{shown.map(doc=>renderDoc(doc))}</ul>}
      {cursor&&<button type="button" className="mt-4 rounded-lg border px-4 py-2" disabled={loading} onClick={()=>void load(true,cursor)}>Charger la suite</button>}
    </div>
    <DocumentPreview target={preview} onClose={()=>setPreview(null)} returnFocus={previewTrigger}/>
  </section>
}
type Runner=(fn:()=>Promise<unknown>,success:string)=>Promise<void>
function PublishButton({doc,busy,run}:{doc:Doc;busy:boolean;run:Runner}){
  const key=useRef<string|undefined>(undefined)
  return <button type="button" disabled={busy} className="rounded-lg bg-blue-800 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={()=>{key.current??=crypto.randomUUID();void run(()=>call(`/api/hr-documents/${doc.id}/publish`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:doc.version,key:key.current})}),"Document publié dans l’espace du salarié. La notification reste suivie séparément.")}}>Publier la version vérifiée</button>
}
function ReviewForm({doc,employees,categories,busy,run}:{doc:Doc;employees:Employee[];categories:Category[];busy:boolean;run:Runner}){
  return <form className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2" onSubmit={e=>{
    e.preventDefault();const f=new FormData(e.currentTarget)
    const data={employeeId:f.get("employeeId"),category:f.get("category"),period:f.get("period"),title:f.get("title"),key:crypto.randomUUID(),expectedVersion:doc.version}
    void run(()=>call(`/api/hr-documents/${doc.id}/review`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),"Affectation et version vérifiées. Publication séparée requise.")
  }}>
    <MetadataFields employees={employees} categories={categories} defaults={doc}/>
    <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required className="mt-1"/>J’ai vérifié le contenu du PDF, le salarié, la période et la catégorie de cette version.</label>
    <button disabled={busy} className="rounded-lg border border-blue-300 px-4 py-2 text-sm text-blue-900 disabled:opacity-50">Valider cette affectation</button>
  </form>
}
type Hint={confidence:number;source:string}
function hintText(h?:Hint|null){
  if(!h)return null
  // Le nom du fichier n'est jamais présenté comme une lecture de la pièce.
  if(h.source==="FILENAME")return "Suggéré d’après le nom du fichier seulement (non lu sur la pièce) — à vérifier."
  const from={MRZ:"la bande MRZ",TEXT:"le texte de la pièce",EXTERNAL:"une lecture externe"}[h.source]??"le document"
  return h.confidence>=0.7?`Lu dans ${from}.`:`Lu dans ${from} — à vérifier.`
}
function HintLine({hint}:{hint?:Hint|null}){
  const text=hintText(hint);if(!text)return null
  return <span className={`mt-1 block text-xs ${hint!.confidence>=0.7?"text-slate-600":"font-medium text-amber-800"}`}>{text}</span>
}
function MetadataFields({employees,categories,defaults,hints}:{employees:Employee[];categories:Category[];defaults?:Partial<Doc>;hints?:{employee?:Hint|null;category?:Hint|null;period?:Hint|null}}){
  const legacyOnly=categories.every(c=>["PAYSLIP","CONTRACT","AMENDMENT","OTHER"].includes(c.code))
  // Options vides sélectionnables (pas `disabled`) : si la valeur proposée est absente, le navigateur retombe sur
  // « Choisir explicitement » (refusé par `required`) et jamais sur le premier salarié ou la première catégorie.
  const employee=employees.some(e=>e.id===defaults?.employeeId)?defaults!.employeeId!:""
  return <><label className="text-sm">Salarié<select required name="employeeId" className={control} defaultValue={employee}><option value="">Choisir explicitement</option>{employees.map(e=><option key={e.id} value={e.id}>{e.lastName} {e.firstName}{e.draft?" (fiche à compléter)":""}</option>)}</select><HintLine hint={hints?.employee}/></label>
    <label className="text-sm">Catégorie<select required name="category" className={control} defaultValue={defaults?.category??(legacyOnly?"PAYSLIP":"")}>{!legacyOnly&&<option value="">À reconnaître — choisir</option>}{categories.map(c=><option key={c.code} value={c.code}>{c.label}</option>)}</select><HintLine hint={hints?.category}/></label>
    <label className="text-sm">Période<input required type="month" name="period" className={control} defaultValue={defaults?.period}/><HintLine hint={hints?.period}/></label>
    <label className="text-sm">Titre privé<input required maxLength={120} name="title" className={control} defaultValue={defaults?.title}/></label></>
}
function RecoveryForm({doc,action,busy,run}:{doc:Doc;action:"RESUME"|"RESTORE";busy:boolean;run:Runner}){
  return <form className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3" onSubmit={e=>{
    e.preventDefault();const form=new FormData(e.currentTarget);form.set("action",action);form.set("expectedVersion",String(doc.version))
    void run(()=>call(`/api/hr-documents/${doc.id}/recover`,{method:"POST",body:form}),"PDF original vérifié. Revue et publication restent nécessaires.")
  }}><label className="min-w-0 text-sm">{action==="RESUME"?"Reprendre avec exactement le PDF réservé":"Restaurer le PDF original, sans changer son destinataire"}<input className="mt-2 block max-w-full" type="file" name="file" accept="application/pdf,.pdf" required disabled={busy}/></label><button disabled={busy} className="rounded-lg border px-3 py-2 text-sm">{action==="RESUME"?"Reprendre ce dépôt":"Restaurer une copie privée"}</button></form>
}
type Read<T=string>={value:T;confidence:number;source:string}|null
type IdentityKey="lastName"|"firstNames"|"birthDate"|"sex"|"nationality"|"expiryDate"
type Proposal={category:Read;period:Read;title:string|null;sources:string[]
  candidates:{employeeId:string;level:"STRONG"|"PARTIAL";draft:boolean}[];proposedEmployeeId:string|null;personSource:string|null;canCreateDraft:boolean;sha256:string;kind:string
  identity:{lastName:Read;firstNames:Read;birthDate:Read;sex:Read<"M"|"F">;nationality:Read;expiryDate:Read;documentNumberEnd:string|null;mrzChecksValid:boolean|null;missing:Partial<Record<IdentityKey,string>>}|null
  textFound:boolean;reading:{status:string;reason:string|null;durationMs:number;rotation:number|null}}
const MISSING:Record<string,string>={NO_TEXT:"rien n’a été lu dans la pièce",ENGINE_MISSING:"moteur OCR local absent",TECHNICAL_FAILURE:"échec technique de la lecture",
  UNREADABLE:"pièce illisible après OCR",NOT_FOUND:"absent du texte lu",NOT_IN_FORMAT:"absent de ce modèle de pièce",UNCERTAIN:"lu, mais trop incertain pour être proposé"}
const FAILURE:Record<string,string>={TIMEOUT:"lecture trop longue, interrompue",IMAGE_NOT_DECODABLE:"format d’image non décodable ici (HEIC : envoyez plutôt un JPG)",
  PAGE_RENDER_UNAVAILABLE:"page PDF sans texte ni image, rendu impossible ici",PDF_UNREADABLE:"PDF illisible",OCR_ERROR:"erreur du moteur OCR"}
/** Ce qui a réellement été lu : couche texte, OCR local, ou pourquoi rien ne l'a été (jamais « illisible » sans OCR). */
function ReadingNotice({p}:{p:Proposal}){
  const r=p.reading,seconds=(r.durationMs/1000).toFixed(1).replace(".",",")
  const fileOnly=p.sources?.length===1&&p.sources[0]==="FILENAME"?" Les seules suggestions viennent du nom du fichier.":""
  if(r.status==="TEXT_LAYER")return null
  if(r.status==="OCR")return <p className="mt-2 rounded-md bg-slate-50 p-2 text-sm text-slate-700">Lu par l’OCR local de Planificator (aucun envoi externe) en {seconds} s{r.rotation?`, image redressée de ${r.rotation}°`:""}. La lecture n’est jamais garantie : comparez chaque champ avec la pièce.</p>
  const text=r.status==="ENGINE_MISSING"?"Le moteur OCR local n’est pas disponible sur ce serveur : rien n’a été lu dans le document."
    :r.status==="TECHNICAL_FAILURE"?`Échec technique de la lecture (${FAILURE[r.reason??""]??"motif inconnu"}) : rien n’a été lu. Ce n’est pas un constat d’illisibilité.`
    :"OCR local tenté : le contenu est illisible (photo floue, reflet ou trop petite). Reprenez une photo nette ou saisissez les champs."
  return <p className="mt-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">{text}{fileOnly}</p>
}
function FieldNote({id,k}:{id:NonNullable<Proposal["identity"]>;k:IdentityKey}){
  const f=id[k]
  if(f)return <HintLine hint={f}/>
  const why=id.missing[k]
  return why?<span className="mt-1 block text-xs text-slate-600">Non lu : {MISSING[why]??why}.</span>:null
}
/**
 * Dépôt groupé depuis le dossier d'un salarié : le destinataire est fixé par le dossier, jamais par la lecture.
 * - OTHER_EMPLOYEE : la lecture (ou le nom du fichier) désigne sans ambiguïté un AUTRE salarié → le fichier bloque tout le lot ;
 * - AMBIGUOUS (homonymes) et PARTIAL (nom de famille seul) : aucun salarié proposé, la vérification humaine reste requise.
 */
export type BatchRecipient="OK"|"OTHER_EMPLOYEE"|"AMBIGUOUS"|"PARTIAL"
export function batchRecipientCheck(p:Pick<Proposal,"candidates"|"proposedEmployeeId">|undefined,employeeId:string):BatchRecipient{
  if(!p)return "OK"
  if(p.proposedEmployeeId)return p.proposedEmployeeId===employeeId?"OK":"OTHER_EMPLOYEE"
  if(p.candidates.filter(c=>c.level==="STRONG").length>1)return "AMBIGUOUS"
  return p.candidates.length?"PARTIAL":"OK"
}
type ImportProps={employees:Employee[];employeeId?:string;employeeName?:string;busy:boolean;run:Runner;categories:Category[];recognition:boolean;images:boolean;drafts:boolean;onDraft:(e:Employee)=>void}
type ImportFile = { file: File; key: string }
type DepositResult = { state: "done" | "error"; message: string }

function ImportPanel(props:ImportProps){
  const {busy,images,recognition,employeeId,run,categories}=props
  const [files,setFiles]=useState<ImportFile[]>([])
  const [sharedCategory,setSharedCategory]=useState("")
  const [selectionError,setSelectionError]=useState("")
  const [results,setResults]=useState<Record<string,DepositResult>>({})
  const [sending,setSending]=useState(false)
  const active=useRef(false)
  const inputs=useRef<HTMLDivElement>(null)
  const attempts=useRef(new Map<string,FormData>())
  const accept=images?"application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/heic,.heic":"application/pdf,.pdf"
  const batch=!!employeeId
  const pending=files.filter(({key})=>results[key]?.state!=="done")
  const locked=busy||sending

  async function deposit(){
    if(active.current||busy||!employeeId||!sharedCategory||!pending.length)return
    setSelectionError("")
    const forms=new Map(Array.from(inputs.current?.querySelectorAll<HTMLFormElement>("form[data-import-key]")??[])
      .map(form=>[form.dataset.importKey,form]))
    // Avant toute requête : un seul fichier désignant un autre salarié bloque tout le lot (aucun envoi, même des fichiers confirmés).
    if(pending.some(({key})=>!attempts.current.has(key)&&forms.get(key)?.dataset.importBlocked==="true")){
      setSelectionError("Dépôt du lot bloqué : un fichier semble concerner un autre salarié que celui de ce dossier. Retirez-le avant de déposer. Aucun fichier n’a été envoyé.");return
    }
    const requests:{key:string;body:FormData}[]=[]
    for(const {key,file} of pending){
      const previous=attempts.current.get(key)
      if(previous){requests.push({key,body:previous});continue}
      const form=forms.get(key)
      if(!form){setSelectionError("Attendez la fin de la lecture de tous les fichiers.");return}
      if(!form.reportValidity())return
      const body=new FormData(form)
      body.delete("checked")
      body.set("employeeId",employeeId)
      body.set("category",sharedCategory)
      body.set("key",key)
      body.set("file",file)
      requests.push({key,body})
    }
    active.current=true
    setSending(true)
    try {
      await run(async()=>{
        for(const {key,body} of requests){
          attempts.current.set(key,body)
          try{
            await call("/api/hr-documents",{method:"POST",body})
            setResults(old=>({...old,[key]:{state:"done",message:"Déposé · À vérifier"}}))
          }catch(e){
            setResults(old=>({...old,[key]:{state:"error",message:e instanceof Error?e.message:"Dépôt indisponible."}}))
          }
        }
      },"Traitement du lot terminé. Consultez le résultat de chaque fichier. Les dépôts restent à vérifier.")
    }finally{
      active.current=false
      setSending(false)
    }
  }

  return <div className="rounded-xl border bg-white p-4"><h2 className="font-semibold">{batch?"Ajouter plusieurs fichiers":images?"Dépôt de documents — unitaire ou lot":"Dépôt PDF — unitaire ou lot"}</h2>
    <p className="my-2 text-sm text-slate-600">10 fichiers au maximum par sélection, 10 Mo par {images?"fichier (PDF, JPG, PNG ou HEIC)":"PDF"}. {batch?"Choisissez la catégorie une fois, puis vérifiez la période et l’affectation de chaque fichier. Aucun document n’est publié lors du dépôt.":recognition?"Vérifiez chaque proposition de classement avant de déposer le fichier.":"Chaque affectation est vérifiée séparément."}</p>
    {batch&&<div className="mb-3 grid gap-3 sm:grid-cols-2">
      <p className="text-sm">Salarié <strong className="block">{props.employeeName||"Salarié de ce dossier"}</strong></p>
      <label className="text-sm">Catégorie du lot<select className={control} value={sharedCategory} disabled={locked||attempts.current.size>0} onChange={e=>{
        setSharedCategory(e.target.value)
        inputs.current?.querySelectorAll<HTMLInputElement>('input[name="checked"]').forEach(box=>{box.checked=false})
      }}>
        <option value="">Choisir une catégorie</option>{categories.map(c=><option key={c.code} value={c.code}>{c.label}</option>)}
      </select></label>
    </div>}
    <label className="block text-sm">{images?"Choisir les documents":"Choisir les PDF"}<input type="file" accept={accept} multiple disabled={locked} className="mt-2 block max-w-full text-sm" onChange={e=>{
      const selection=Array.from(e.target.files??[])
      e.target.value=""
      if(!selection.length)return
      if(selection.length>10){setSelectionError("Sélectionnez 10 fichiers au maximum.");return}
      setSelectionError("");setResults({});attempts.current.clear()
      setFiles(selection.map(file=>({file,key:crypto.randomUUID()})))
    }}/></label>
    {selectionError&&<p role="alert" className="mt-2 text-sm text-red-800">{selectionError}</p>}
    <div ref={inputs} className="space-y-4">{files.map(({file,key})=><div key={key}>
      {results[key]?.state==="done"
        ?<p className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-900">{file.name} · {results[key].message}</p>
        :<><ImportItem file={file} fileKey={key} {...props} busy={locked} batch={batch} attempted={attempts.current.has(key)} onRemove={()=>{setSelectionError("");setFiles(list=>list.filter(f=>f.key!==key))}}/>
          {results[key]?.state==="error"&&<p role="alert" className="mt-1 text-sm text-red-800">{results[key].message}</p>}
        </>}
    </div>)}</div>
    {batch&&pending.length>0&&<button type="button" disabled={locked||!sharedCategory} className="mt-4 rounded-lg bg-blue-900 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={()=>void deposit()}>
      {sending?"Dépôt en cours…":attempts.current.size?"Reprendre les dépôts en échec":`Déposer ${pending.length} fichier${pending.length===1?"":"s"}`}
    </button>}
  </div>
}
function ImportItem({file,fileKey,employees,employeeId,busy,run,categories,recognition,drafts,onDraft,batch=false,attempted=false,onRemove}:ImportProps&{file:File;fileKey:string;batch?:boolean;attempted?:boolean;onRemove?:()=>void}){
  const [state,setState]=useState<{status:"idle"|"loading"|"done"|"error";proposal?:Proposal}>(recognition?{status:"loading"}:{status:"idle"})
  const [selected,setSelected]=useState<string|undefined>(employeeId)
  // Fin de validité saisie dans la fiche : reprise comme période du document si aucune n'a été proposée.
  const [periodFromDraft,setPeriodFromDraft]=useState<string|undefined>()
  useEffect(()=>{
    if(!recognition)return
    let live=true;const form=new FormData();form.set("file",file)
    call("/api/hr-documents/recognize",{method:"POST",body:form}).then(d=>{if(live)setState({status:"done",proposal:d.proposal as Proposal})}).catch(()=>{if(live)setState({status:"error"})})
    return()=>{live=false}
  },[file,recognition])
  const p=state.proposal
  const strong=p?.candidates.filter(c=>c.level==="STRONG")??[]
  const proposedEmployee=selected??p?.proposedEmployeeId??undefined
  // Salarié proposé : la confiance est celle du nom lu ; venu du seul nom du fichier, il reste « à vérifier ».
  const employeeHint=p?.proposedEmployeeId&&!employeeId&&p.personSource
    ?{confidence:p.personSource==="FILENAME"?0.5:p.identity?.lastName?.confidence??0.5,source:p.personSource}:null
  const defaults:Partial<Doc>={employeeId:proposedEmployee,category:p?.category?.value,period:p?.period?.value??periodFromDraft,title:batch?file.name.replace(/\.[^.]+$/,"").slice(0,120):p?.title??undefined}
  // Lot d'un dossier : destinataire fixé. La lecture ne sert qu'à alerter (autre salarié → blocage) ; le titre privé ne reprend
  // jamais la proposition de la lecture, qui peut contenir un nom lu sur la pièce : nom du fichier, modifiable.
  const recipient:BatchRecipient=batch&&employeeId?batchRecipientCheck(p,employeeId):"OK"
  const blocked=recipient==="OTHER_EMPLOYEE"
  return <div className="mt-4 rounded-lg border p-3">
    <p className="break-all text-sm font-medium">{file.name}</p>
    {state.status==="loading"&&<p role="status" className="mt-2 text-sm text-slate-600">Lecture du document en cours…</p>}
    {state.status==="error"&&<p className="mt-2 text-sm text-amber-800">Le document n’a pas pu être lu automatiquement : renseignez les champs à la main.</p>}
    {p&&<ReadingNotice p={p}/>}
    {p&&!p.category&&<p className="mt-2 text-sm text-amber-800">Type non reconnu : choisissez la catégorie à la main.</p>}
    {!batch&&p&&strong.length>1&&<p className="mt-2 text-sm font-medium text-amber-800">Plusieurs salariés portent ce nom : choisissez explicitement le bon salarié.</p>}
    {!batch&&p&&!strong.length&&p.candidates.length>0&&<p className="mt-2 text-sm text-amber-800">Nom de famille seulement reconnu : vérifiez le salarié.</p>}
    {blocked&&<div role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm font-medium text-red-900">
      <p>{p?.personSource==="FILENAME"?"Le nom de ce fichier désigne":"La lecture de cette pièce reconnaît"} un autre salarié que celui de ce dossier. Ce fichier ne peut pas être déposé ici et bloque le dépôt du lot : retirez-le, puis déposez-le depuis le dossier du bon salarié.</p>
      {onRemove&&<button type="button" disabled={busy} className="mt-2 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-normal text-red-900 disabled:opacity-50" onClick={onRemove}>Retirer ce fichier du lot</button>}
    </div>}
    {recipient==="AMBIGUOUS"&&<p className="mt-2 text-sm font-medium text-amber-800">Plusieurs salariés portent le nom lu sur ce fichier. Le destinataire reste le salarié de ce dossier : vérifiez sur la pièce qu’elle le concerne avant de confirmer.</p>}
    {recipient==="PARTIAL"&&<p className="mt-2 text-sm text-amber-800">Nom de famille seulement reconnu sur ce fichier. Le destinataire reste le salarié de ce dossier : vérifiez sur la pièce qu’elle le concerne avant de confirmer.</p>}
    {state.status!=="loading"&&<form data-import-key={fileKey} data-import-blocked={blocked?"true":undefined} key={`${state.status}:${selected??""}:${employees.length}:${periodFromDraft??""}`} className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={e=>{
      e.preventDefault();if(batch)return
      const f=new FormData(e.currentTarget);f.delete("checked");f.set("key",fileKey);f.set("file",file)
      void run(()=>call("/api/hr-documents",{method:"POST",body:f}),"Document déposé en préparation. Vérification et publication restent nécessaires.")
    }}>{batch ? <fieldset disabled={busy||attempted||blocked} className="grid min-w-0 gap-3 sm:col-span-2 sm:grid-cols-2">
      <label className="text-sm">Période<input required type="month" name="period" className={control} defaultValue={defaults.period}/><HintLine hint={p?.period}/></label>
      <label className="text-sm">Titre privé<input required maxLength={120} name="title" className={control} defaultValue={defaults.title}/></label>
      {p?.category&&<p className="text-xs text-slate-600 sm:col-span-2">Type proposé : {categoryLabel(p.category.value)}</p>}
      <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="checked" required className="mt-1"/>J’ai vérifié le salarié, la catégorie et la période sur ce fichier.</label>
    </fieldset> : <><MetadataFields employees={employees} categories={categories} defaults={defaults} hints={p?{employee:employeeHint,category:p.category,period:p.period}:undefined}/>
      {p&&<label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="checked" required className="mt-1"/>J’ai vérifié la proposition (type, salarié, période) sur le document.</label>}
      <button disabled={busy} className="rounded-lg bg-blue-800 px-3 py-2 text-sm text-white disabled:opacity-50">Déposer ce document privé</button></>}</form>}
    {p?.canCreateDraft&&drafts&&!selected&&<DraftPanel file={file} proposal={p} categories={categories} busy={busy} run={run} onCreated={(e,expiry)=>{onDraft(e);setSelected(e.id);if(expiry)setPeriodFromDraft(expiry.slice(0,7))}}/>}
  </div>
}
/** Zone photo standard d'une carte ou d'une page de passeport : proposition à confirmer, sans détection de visage. */
async function cropIdPhoto(file:File):Promise<Blob|null>{
  if(!["image/jpeg","image/png"].includes(file.type))return null
  try{
    const bitmap=await createImageBitmap(file)
    const sx=Math.round(bitmap.width*0.03),sy=Math.round(bitmap.height*0.18),sw=Math.round(bitmap.width*0.3),sh=Math.round(bitmap.height*0.64)
    const canvas=document.createElement("canvas");canvas.width=sw;canvas.height=sh
    canvas.getContext("2d")!.drawImage(bitmap,sx,sy,sw,sh,0,0,sw,sh);bitmap.close()
    return await new Promise(resolve=>canvas.toBlob(b=>resolve(b),"image/jpeg",0.9))
  }catch{return null}
}
function DraftPanel({file,proposal,categories,busy,run,onCreated}:{file:File;proposal:Proposal;categories:Category[];busy:boolean;run:Runner;onCreated:(e:Employee,expiry?:string)=>void}){
  const id=proposal.identity!
  const [photo,setPhoto]=useState<{blob:Blob;url:string}|null>(null)
  const photoAllowed=categories.some(c=>c.code==="ID_PHOTO")
  useEffect(()=>{
    if(!photoAllowed)return
    let url="";void cropIdPhoto(file).then(blob=>{if(blob){url=URL.createObjectURL(blob);setPhoto({blob,url})}})
    return()=>{if(url)URL.revokeObjectURL(url)}
  },[file,photoAllowed])
  const read=(["lastName","firstNames","birthDate","sex","nationality","expiryDate"] as const).filter(k=>id[k]).length
  const notice=!read?"Rien n’a été lu dans la pièce : saisissez chaque champ en regardant la pièce (le nom du fichier n’est pas utilisé)."
    :id.mrzChecksValid===true?"Bande MRZ lue, chiffres de contrôle justes ; les noms n’y sont pas contrôlés : comparez chaque champ avec la pièce."
    :"Informations lues sans contrôle MRZ complet : comparez chaque champ avec la pièce. Les champs vides indiquent pourquoi."
  return <form className="mt-4 grid gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 sm:grid-cols-2" onSubmit={e=>{
    e.preventDefault();const f=new FormData(e.currentTarget)
    const value=(k:string)=>{const v=String(f.get(k)??"").trim();return v||undefined}
    const body={firstName:value("firstName"),lastName:value("lastName"),birthDate:value("birthDate"),sex:value("sex"),nationality:value("nationality")?.toUpperCase(),
      identityExpiry:value("identityExpiry"),documentNumberEnd:id.documentNumberEnd??undefined,sourceSha256:proposal.sha256,key:crypto.randomUUID()}
    const usePhoto=f.get("usePhoto")==="on"&&photo
    void run(async()=>{
      const created=(await call("/api/hr-documents/employees",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).employee as Employee
      if(usePhoto){
        const pf=new FormData();pf.set("employeeId",created.id);pf.set("category","ID_PHOTO");pf.set("period",proposal.period?.value??new Date().toISOString().slice(0,7))
        pf.set("title",`Photo d’identité — ${created.lastName} ${created.firstName}`.slice(0,120));pf.set("key",crypto.randomUUID());pf.set("file",new File([photo.blob],"photo.jpg",{type:"image/jpeg"}))
        await call("/api/hr-documents",{method:"POST",body:pf})
      }
      onCreated(created,body.identityExpiry);return created
    },"Fiche à compléter créée (inactive, sans invitation). Déposez maintenant la pièce pour ce salarié.")
  }}>
    <p className="text-sm font-semibold text-amber-950 sm:col-span-2">Personne absente de la société — créer une fiche à compléter</p>
    <p className="text-xs text-amber-900 sm:col-span-2">{notice} La fiche reste inactive et aucune invitation n’est envoyée.</p>
    <label className="text-sm">Nom<input required name="lastName" maxLength={80} className={control} defaultValue={id.lastName?.value}/><FieldNote id={id} k="lastName"/></label>
    <label className="text-sm">Prénoms<input required name="firstName" maxLength={80} className={control} defaultValue={id.firstNames?.value}/><FieldNote id={id} k="firstNames"/></label>
    <label className="text-sm">Date de naissance<input type="date" name="birthDate" className={control} defaultValue={id.birthDate?.value}/><FieldNote id={id} k="birthDate"/></label>
    <label className="text-sm">Sexe<select name="sex" className={control} defaultValue={id.sex?.value??""}><option value="">Non renseigné</option><option value="F">F</option><option value="M">M</option></select><FieldNote id={id} k="sex"/></label>
    <label className="text-sm">Nationalité (3 lettres)<input name="nationality" maxLength={3} pattern="[A-Za-z]{3}" className={control} defaultValue={id.nationality?.value}/><FieldNote id={id} k="nationality"/></label>
    <label className="text-sm">Fin de validité de la pièce<input type="date" name="identityExpiry" className={control} defaultValue={id.expiryDate?.value}/><FieldNote id={id} k="expiryDate"/></label>
    {id.documentNumberEnd&&<p className="text-xs text-slate-600 sm:col-span-2">Numéro de pièce : seuls les 4 derniers caractères sont conservés (…{id.documentNumberEnd}).</p>}
    {photo&&<div className="flex items-center gap-3 sm:col-span-2"><img src={photo.url} alt="Photo proposée, extraite de la zone photo de la pièce" className="h-24 w-20 rounded-md border object-cover"/>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="usePhoto" className="mt-1"/>Utiliser cette photo (proposition à confirmer : zone photo standard de la pièce, sans reconnaissance du visage).</label></div>}
    <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required className="mt-1"/>J’ai comparé ces informations avec la pièce d’identité.</label>
    <button disabled={busy} className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-950 disabled:opacity-50">Créer la fiche à compléter</button>
  </form>
}
