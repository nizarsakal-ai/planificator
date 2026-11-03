import { hrIdentity,hrService } from "@/lib/hr-documents/runtime"
import { hrHttp,PRIVATE_HEADERS } from "@/lib/hr-documents/http"
import { KIND_MIME } from "@/lib/hr-documents/domain"
export const runtime="nodejs"
export const dynamic="force-dynamic"
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  const {bytes,kind,title}=await hrService().download(await hrIdentity(),(await params).id)
  // Type réel relu dans les octets vérifiés ; toujours en pièce jointe, jamais affiché en ligne.
  return new Response(Buffer.from(bytes),{headers:{...PRIVATE_HEADERS,"Content-Type":KIND_MIME[kind],
    "Content-Disposition":`attachment; filename="${title}"`,"Content-Length":String(bytes.length),
    "X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox; default-src 'none'"}})
})}
