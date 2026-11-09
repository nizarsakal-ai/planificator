import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity,hrOperator,hrService } from "@/lib/hr-documents/runtime"
import { HrError,privateSpaceEnabled,publicationSchema } from "@/lib/hr-documents/domain"
import { boundedJson,hrHttp,hrJson } from "@/lib/hr-documents/http"
export const dynamic="force-dynamic"
/** RH : une pièce reçue du salarié passe « à vérifier » dans le circuit existant ; aucune publication ici. */
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return hrHttp(async()=>{
  if(!privateSpaceEnabled())throw new HrError("DISABLED",404)
  const identity=await hrIdentity();assertMutationOrigin(request);await hrOperator(identity,"IMPORT")
  const input=publicationSchema.parse(await boundedJson(request))
  return hrJson({document:await hrService().accept(identity,(await params).id,input.expectedVersion)})
})}
