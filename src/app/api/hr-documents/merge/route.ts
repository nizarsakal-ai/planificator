import { assertMutationOrigin } from "@/lib/http/request-origin"
import { hrIdentity, hrOperator, hrService } from "@/lib/hr-documents/runtime"
import { boundedJson, hrHttp, hrJson } from "@/lib/hr-documents/http"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
/** Fusion de deux dossiers du même salarié : documents et messages RH rattachés à la fiche cible, source fermée. */
export async function POST(request: Request) {
  return hrHttp(async () => {
    const identity = await hrIdentity(); assertMutationOrigin(request); await hrOperator(identity, "PUBLISH")
    return hrJson({ merged: await hrService().mergeEmployees(identity, await boundedJson(request)) })
  })
}
