import { hrIdentity, hrService } from "@/lib/hr-documents/runtime"
import { hrHttp, hrJson } from "@/lib/hr-documents/http"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
/** Lecture RH : compte de connexion de la fiche et documents réellement visibles par le salarié. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return hrHttp(async () => {
    const { id } = await params
    return hrJson({ access: await hrService().employeeAccess(await hrIdentity(), id) })
  })
}
