import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity,hrOperator,hrService } from "@/lib/hr-documents/runtime"
import { boundedJson,hrHttp,hrJson } from "@/lib/hr-documents/http"
export const dynamic="force-dynamic"
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request);await hrOperator(identity,"IMPORT");return hrJson({document:await hrService().review(identity,(await params).id,await boundedJson(request))})
})}
