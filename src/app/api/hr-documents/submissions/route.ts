import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrEmployeePortalEnabled,hrIdentity,hrService } from "@/lib/hr-documents/runtime"
import { boundedForm,hrHttp,hrJson } from "@/lib/hr-documents/http"
import { HrError,imagesEnabled,MAX_PDF_BYTES,privateSpaceEnabled } from "@/lib/hr-documents/domain"
export const runtime="nodejs"
export const dynamic="force-dynamic"
/** Dépôt d'une pièce par le salarié connecté, pour lui-même : aucun champ employeeId accepté. */
export async function POST(request:Request){return hrHttp(async()=>{
  if(!privateSpaceEnabled()||!hrEmployeePortalEnabled())throw new HrError("DISABLED",404)
  const identity=await hrIdentity();assertMutationOrigin(request);const form=await boundedForm(request)
  const allowed=["category","period","title","key","requestId","file"]
  for(const [key] of form)if(!allowed.includes(key)||form.getAll(key).length!==1)throw new HrError("INVALID_INPUT")
  const file=form.get("file")
  if(!(file instanceof File)||file.size>MAX_PDF_BYTES)throw new HrError(imagesEnabled()?"INVALID_FILE":"INVALID_PDF")
  const input=Object.fromEntries(allowed.filter(k=>k!=="file"&&form.has(k)).map(k=>[k,form.get(k)]))
  return hrJson({document:await hrService().submit(identity,input,new Uint8Array(await file.arrayBuffer()))},201)
})}
