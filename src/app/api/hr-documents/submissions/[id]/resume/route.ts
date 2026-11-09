import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrEmployeePortalEnabled,hrIdentity,hrService } from "@/lib/hr-documents/runtime"
import { boundedForm,hrHttp,hrJson } from "@/lib/hr-documents/http"
import { HrError,imagesEnabled,MAX_PDF_BYTES,privateSpaceEnabled } from "@/lib/hr-documents/domain"
export const runtime="nodejs"
export const dynamic="force-dynamic"
/** Reprise par le salarié de son propre dépôt « Envoi en cours » : même fichier resélectionné, contrôles faits par le service. */
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  if(!privateSpaceEnabled()||!hrEmployeePortalEnabled())throw new HrError("DISABLED",404)
  const identity=await hrIdentity();assertMutationOrigin(request);const form=await boundedForm(request)
  for(const [key] of form)if(!["file","expectedVersion"].includes(key)||form.getAll(key).length!==1)throw new HrError("INVALID_INPUT")
  const version=Number(form.get("expectedVersion"))
  if(!Number.isInteger(version)||version<1||version>2147483647)throw new HrError("INVALID_INPUT")
  const file=form.get("file")
  if(!(file instanceof File)||file.size>MAX_PDF_BYTES)throw new HrError(imagesEnabled()?"INVALID_FILE":"INVALID_PDF")
  return hrJson({document:await hrService().resumeSubmission(identity,(await params).id,version,new Uint8Array(await file.arrayBuffer()))})
})}
