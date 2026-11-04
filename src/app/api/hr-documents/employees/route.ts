import { hrIdentity,hrOperator,hrService } from "@/lib/hr-documents/runtime"
import { boundedJson,hrHttp,hrJson } from "@/lib/hr-documents/http"
import { employeeDraftsEnabled,HrError } from "@/lib/hr-documents/domain"
import { assertMutationOrigin } from "@/lib/http/request-origin"
export const dynamic="force-dynamic"
export async function GET(){return hrHttp(async()=>hrJson({employees:await hrService().employees(await hrIdentity())}))}
/** PLV2-DOC-RH-002 — fiche à compléter depuis une pièce d'identité, après validation explicite de l'opérateur. */
export async function POST(request:Request){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request)
  if(!employeeDraftsEnabled())throw new HrError("DISABLED",404)
  const body=await boundedJson(request);await hrOperator(identity,"IMPORT")
  return hrJson({employee:await hrService().createDraft(identity,body)},201)
})}
