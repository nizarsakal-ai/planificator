import { hrIdentity,hrService } from "@/lib/hr-documents/runtime"
import { hrHttp,PRIVATE_HEADERS } from "@/lib/hr-documents/http"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  const {bytes,title}=await hrService().download(await hrIdentity(),(await params).id)
  return new Response(Buffer.from(bytes),{headers:{...PRIVATE_HEADERS,"Content-Type":"application/pdf",
    "Content-Disposition":`attachment; filename="${title}"`,"Content-Length":String(bytes.length),
    "X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox; default-src 'none'"}})
})}
