import { ZodError } from "zod"
import { assertMutationOrigin } from "@/lib/http/request-origin"
import { HttpGuardError } from "@/lib/http/guard-error"
import { HrError, MAX_PDF_BYTES, messages } from "./domain"
import { boundedBytes } from "./drive"

export const PRIVATE_HEADERS={"Cache-Control":"private, no-store, max-age=0",Vary:"Cookie",Pragma:"no-cache"}
export function hrJson(body:unknown,status=200){return Response.json(body,{status,headers:PRIVATE_HEADERS})}
export async function hrHttp(fn:()=>Promise<Response>){
  try{return await fn()}catch(error){
    if(error instanceof ZodError)return hrJson({error:messages.INVALID_INPUT,code:"INVALID_INPUT"},400)
    // Motif technique fixe seulement (aucune valeur, aucun identifiant) : distingue les causes de STORAGE_NOT_READY.
    if(error instanceof HrError&&error.code==="STORAGE_NOT_READY")console.warn("[hr-documents] STORAGE_NOT_READY",{reason:error.reason??"non_precise"})
    if(error instanceof HrError)return hrJson({error:messages[error.code]??"Opération indisponible.",code:error.code},error.status)
    if(error instanceof HttpGuardError)return hrJson({error:"Accès non autorisé."},403)
    // No raw Prisma/provider exception, filename, body, token or employee data is logged or returned.
    return hrJson({error:"Le service est indisponible. Réessayez sans changer la même opération.",code:"UNAVAILABLE"},503)
  }
}
export async function boundedForm(request:Request){
  assertMutationOrigin(request)
  if(!request.headers.get("content-type")?.startsWith("multipart/form-data;"))throw new HrError("INVALID_INPUT")
  if(!request.body)throw new HrError("INVALID_INPUT")
  const bytes=await boundedBytes(request.body,MAX_PDF_BYTES+64*1024)
  return new Request(request.url,{method:"POST",headers:{"content-type":request.headers.get("content-type")!},body:Buffer.from(bytes)}).formData()
}
export async function boundedJson(request:Request){
  assertMutationOrigin(request)
  if(!request.body)throw new HrError("INVALID_INPUT")
  const bytes=await boundedBytes(request.body,16*1024)
  try{return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown}catch{throw new HrError("INVALID_INPUT")}
}
