import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrEmployeePortalEnabled,hrIdentity,hrService } from "@/lib/hr-documents/runtime"
import { boundedJson,hrHttp,hrJson } from "@/lib/hr-documents/http"
import { HrError,privateSpaceEnabled } from "@/lib/hr-documents/domain"
export const runtime="nodejs"
export const dynamic="force-dynamic"
/** Fil privé : côté RH avec ?employeeId= (habilitation vérifiée par le service), sinon le fil du salarié connecté. */
export async function GET(request:Request){return hrHttp(async()=>{
  if(!privateSpaceEnabled())throw new HrError("DISABLED",404)
  const identity=await hrIdentity();const url=new URL(request.url)
  const ids=url.searchParams.getAll("employeeId"),cursors=url.searchParams.getAll("cursor")
  if(ids.length>1||cursors.length>1)throw new HrError("INVALID_INPUT")
  if(!ids.length&&!hrEmployeePortalEnabled())throw new HrError("DISABLED",404)
  return hrJson(await hrService().thread(identity,ids[0],cursors[0]))
})}
export async function POST(request:Request){return hrHttp(async()=>{
  if(!privateSpaceEnabled())throw new HrError("DISABLED",404)
  const identity=await hrIdentity();assertMutationOrigin(request)
  const body=await boundedJson(request)
  if(!(body&&typeof body==="object"&&"employeeId" in body)&&!hrEmployeePortalEnabled())throw new HrError("DISABLED",404)
  return hrJson({message:await hrService().post(identity,body)},201)
})}
