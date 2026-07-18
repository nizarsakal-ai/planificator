import { NextResponse } from "next/server"
import { auth } from "@/auth"
import type { AttachmentAccessServiceDeps } from "@/lib/acquisition/access/attachment-access.port"
import {
  accessAcquisitionAttachment,
  buildAccessResponseHeaders,
  mapAccessResultToPublicMessage,
  mapAccessResultToStatus,
} from "@/lib/acquisition/access/attachment-access.service"
import type { AttachmentAccessContext, AttachmentAccessMode } from "@/lib/acquisition/access/attachment-access.types"
import { resolveMimeType } from "@/lib/acquisition/access/attachment-access.types"

export interface HandleAcquisitionAttachmentAccessDeps extends AttachmentAccessServiceDeps {
  auth?: () => Promise<{
    user: { id: string; role: import("@prisma/client").Role; companyId: string | null }
  } | null>
}

export async function handleAcquisitionAttachmentAccess(
  req: Request,
  attachmentId: string,
  deps: HandleAcquisitionAttachmentAccessDeps = {}
): Promise<Response> {
  const authenticate = deps.auth ?? auth
  const session = await authenticate()

  if (!session?.user?.id) {
    return new NextResponse("Non autorisé", { status: 401 })
  }

  const context: AttachmentAccessContext = {
    userId: session.user.id,
    role: session.user.role,
    companyId: session.user.companyId,
  }

  const forceDownload = new URL(req.url).searchParams.get("dl") === "1"
  const mode: AttachmentAccessMode = forceDownload ? "DOWNLOAD" : "VIEW"

  const result = await accessAcquisitionAttachment(
    { context, attachmentId, mode },
    deps
  )

  if (result.kind !== "OK") {
    return new NextResponse(mapAccessResultToPublicMessage(result), {
      status: mapAccessResultToStatus(result),
    })
  }

  const headers = buildAccessResponseHeaders({
    ...result,
    mimeType: resolveMimeType(result.mimeType, result.filename),
  })

  return new NextResponse(result.stream, { status: 200, headers })
}
