import { hrIdentity,hrService } from "@/lib/hr-documents/runtime"
import { hrHttp,hrJson } from "@/lib/hr-documents/http"
export const dynamic="force-dynamic"
export async function GET(){return hrHttp(async()=>hrJson({employees:await hrService().employees(await hrIdentity())}))}
