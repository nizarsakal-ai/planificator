import { auth } from "@/auth"
import { createUploadEmlAdmission } from "@/lib/acquisition/admission/upload-eml-consultations-admission"
import { handleAdminEmlUpload } from "@/lib/integration/connectors/upload-eml/handle-admin-eml-upload"

export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const session = await auth()
  return handleAdminEmlUpload(request, session?.user ?? null, createUploadEmlAdmission())
}
