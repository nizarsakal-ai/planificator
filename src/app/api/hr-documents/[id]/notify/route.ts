import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity,hrOperator } from "@/lib/hr-documents/runtime"
import { dispatchHrNotice } from "@/lib/hr-documents/mail-runtime"
import { hrHttp,hrJson } from "@/lib/hr-documents/http"
export const dynamic="force-dynamic"
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request);await hrOperator(identity,"PUBLISH");assertMutationOrigin(request)
  return hrJson({notification:await dispatchHrNotice(identity,(await params).id)})
})}
