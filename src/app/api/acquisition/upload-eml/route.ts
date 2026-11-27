import { auth } from "@/auth"
import { createUploadEmlAdmission } from "@/lib/acquisition/admission/upload-eml-consultations-admission"
import { handleAdminEmlUpload } from "@/lib/integration/connectors/upload-eml/handle-admin-eml-upload"

export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  const admission = createUploadEmlAdmission(undefined, process.env, {
    allowAttachments: process.env.INTEGRATION_EML_UPLOAD_ATTACHMENTS_ENABLED === "true",
  })
  return handleAdminEmlUpload(request, session?.user ?? null, admission)
}
