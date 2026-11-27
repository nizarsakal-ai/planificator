import { isRoutingActiveForCompany } from "@/lib/integration/flags/platform-flags"
import { readEmlStream } from "./read-eml-stream"

type UploadActor = { id?: string | null; companyId?: string | null; role?: string | null }
type ParsedUpload = Extract<Awaited<ReturnType<typeof readEmlStream>>, { ok: true }>

type UploadDecision =
  | { outcome: "DRAFT_CREATED"; draftId: string; created: boolean }
  | { outcome: "NOT_ADMITTED" }
  | { outcome: "UPLOAD_ATTACHMENTS_UNAVAILABLE" | "UPLOAD_BODY_INVALID" | "UPLOAD_CONNECTION_UNAVAILABLE" }

export type UploadAdmission = (context: {
  companyId: string
  actorId: string
  message: ParsedUpload["message"]
}) => Promise<UploadDecision>

/** La session authentifiée est fournie par le point d’entrée serveur. */
export async function handleAdminEmlUpload(
  request: Request,
  actor: UploadActor | null,
  admit: UploadAdmission,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const respond = (status: number, payload: Record<string, unknown>) =>
    Response.json(payload, { status, headers: { "Cache-Control": "no-store" } })

  if (!actor?.id) return respond(401, { code: "AUTHENTICATION_REQUIRED" })
  if (!actor.companyId || (actor.role !== "ADMIN" && actor.role !== "SUPER_ADMIN")) {
    return respond(403, { code: "UPLOAD_FORBIDDEN" })
  }
  if (env.INTEGRATION_EML_UPLOAD_ENABLED !== "true" || !isRoutingActiveForCompany(actor.companyId, env)) {
    return respond(404, { code: "UPLOAD_DISABLED" })
  }
  if (!request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "message/rfc822") {
    return respond(415, { code: "EML_MEDIA_TYPE_REQUIRED" })
  }

  const parsed = await readEmlStream(request.body)
  if (!parsed.ok) {
    return respond(parsed.code === "EML_TOO_LARGE" ? 413 : 422, { code: parsed.code })
  }

  try {
    const result = await admit({ companyId: actor.companyId, actorId: actor.id, message: parsed.message })
    if (result.outcome === "UPLOAD_CONNECTION_UNAVAILABLE") return respond(409, result)
    if (result.outcome === "UPLOAD_ATTACHMENTS_UNAVAILABLE" || result.outcome === "UPLOAD_BODY_INVALID") {
      return respond(422, result)
    }
    return respond(result.outcome === "DRAFT_CREATED" && result.created ? 201 : 200, result)
  } catch {
    return respond(500, { code: "UPLOAD_ADMISSION_FAILED" })
  }
}
