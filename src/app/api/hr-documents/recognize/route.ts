import { hrIdentity,hrOperator,hrService } from "@/lib/hr-documents/runtime"
import { boundedForm,hrHttp,hrJson } from "@/lib/hr-documents/http"
import { HrError,MAX_PDF_BYTES,recognitionEnabled } from "@/lib/hr-documents/domain"
import { assertMutationOrigin } from "@/lib/http/request-origin"
export const runtime="nodejs"
export const dynamic="force-dynamic"
/** PLV2-DOC-RH-002 — proposition de classement d'un fichier, sans aucune écriture ni journalisation de son contenu. */
export async function POST(request:Request){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request)
  if(!recognitionEnabled())throw new HrError("DISABLED",404)
  await hrOperator(identity,"IMPORT")
  const form=await boundedForm(request)
  for(const [key] of form)if(key!=="file"||form.getAll(key).length!==1)throw new HrError("INVALID_INPUT")
  const file=form.get("file")
  if(!(file instanceof File)||file.size>MAX_PDF_BYTES)throw new HrError("INVALID_FILE")
  return hrJson({proposal:await hrService().recognize(identity,new Uint8Array(await file.arrayBuffer()),file.name)})
})}
