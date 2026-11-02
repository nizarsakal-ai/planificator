import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity,hrOperator,hrService } from "@/lib/hr-documents/runtime"
import { HrError,MAX_PDF_BYTES } from "@/lib/hr-documents/domain"
import { boundedForm,boundedJson,hrHttp,hrJson } from "@/lib/hr-documents/http"
import { z } from "zod"
const command=z.object({action:z.enum(["RESUME","REVERIFY","RESTORE"]),expectedVersion:z.number().int().positive()}).strict()
export const runtime="nodejs"
export const dynamic="force-dynamic"
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request);await hrOperator(identity,"IMPORT");const id=(await params).id,service=hrService()
  if(request.headers.get("content-type")?.startsWith("application/json")){
    const input=command.parse(await boundedJson(request))
    if(input.action!=="REVERIFY")throw new HrError("INVALID_INPUT")
    return hrJson({document:await service.reverify(identity,id,input.expectedVersion)})
  }
  const form=await boundedForm(request)
  for(const [key] of form)if(!["file","action","expectedVersion"].includes(key)||form.getAll(key).length!==1)throw new HrError("INVALID_INPUT")
  const input=command.parse({action:form.get("action"),expectedVersion:Number(form.get("expectedVersion"))})
  const file=form.get("file")
  if(input.action==="REVERIFY"||!(file instanceof File)||file.size>MAX_PDF_BYTES)throw new HrError("INVALID_INPUT")
  const bytes=new Uint8Array(await file.arrayBuffer())
  const document=input.action==="RESUME"?await service.resume(identity,id,input.expectedVersion,bytes):await service.reverify(identity,id,input.expectedVersion,bytes)
  return hrJson({document})
})}
