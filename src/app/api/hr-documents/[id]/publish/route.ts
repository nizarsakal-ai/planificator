import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity,hrOperator,hrService } from "@/lib/hr-documents/runtime"
import { publicationSchema } from "@/lib/hr-documents/domain"
import { boundedJson,hrHttp,hrJson } from "@/lib/hr-documents/http"
import { dispatchHrNotice } from "@/lib/hr-documents/mail-runtime"
export const dynamic="force-dynamic"
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request);await hrOperator(identity,"PUBLISH");const input=publicationSchema.parse(await boundedJson(request))
  const id=(await params).id
  const document=await hrService().publish(identity,id,input.expectedVersion,input.key)
  // A failed notification never turns a successful publication into a failed/repeated decision.
  let notification="PENDING"
  try{notification=await dispatchHrNotice(identity,id)}catch{/* durable notice remains available for reconciliation */}
  return hrJson({document,notification})
})}
