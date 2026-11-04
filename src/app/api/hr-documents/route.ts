import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity,hrOperator, hrService } from "@/lib/hr-documents/runtime"
import { boundedForm, hrHttp, hrJson } from "@/lib/hr-documents/http"
import { HrError, imagesEnabled, MAX_PDF_BYTES } from "@/lib/hr-documents/domain"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export async function GET(request:Request){return hrHttp(async()=>{
  const identity=await hrIdentity();const url=new URL(request.url)
  const cursor=url.searchParams.get("cursor")??undefined
  if(cursor&&!/^[a-zA-Z0-9_-]{1,128}$/.test(cursor))throw new HrError("INVALID_INPUT")
  if(url.searchParams.getAll("employeeId").length>1)throw new HrError("INVALID_INPUT")
  const docs=await hrService().list(identity,url.searchParams.get("manage")==="true",cursor,url.searchParams.get("employeeId")??undefined)
  return hrJson({documents:docs.slice(0,25),nextCursor:docs.length>25?docs[24].id:null})
})}
export async function POST(request:Request){return hrHttp(async()=>{
  const identity=await hrIdentity();assertMutationOrigin(request);await hrOperator(identity,"IMPORT");const form=await boundedForm(request)
  const allowed=["employeeId","category","period","title","key","file"]
  for(const [key] of form)if(!allowed.includes(key)||form.getAll(key).length!==1)throw new HrError("INVALID_INPUT")
  const file=form.get("file")
  if(!(file instanceof File)||file.size>MAX_PDF_BYTES)throw new HrError(imagesEnabled()?"INVALID_FILE":"INVALID_PDF")
  const input=Object.fromEntries(allowed.filter(k=>k!=="file").map(k=>[k,form.get(k)]))
  return hrJson({document:await hrService().import(identity,input,new Uint8Array(await file.arrayBuffer()))},201)
})}
