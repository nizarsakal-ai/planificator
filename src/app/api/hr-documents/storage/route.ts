import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity,hrOperator,hrService } from "@/lib/hr-documents/runtime"
import { hrHttp,hrJson,boundedJson } from "@/lib/hr-documents/http"
import { z } from "zod"
export const dynamic="force-dynamic"
export async function POST(request:Request){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request);await hrOperator(identity,"CONFIGURE");assertMutationOrigin(request)
  if(request.headers.get("content-type")?.startsWith("application/json")){
    z.object({action:z.literal("REASSOCIATE")}).strict().parse(await boundedJson(request))
    await hrService().reassociate(identity)
  }else await hrService().configure(identity)
  return hrJson({ok:true})
})}
