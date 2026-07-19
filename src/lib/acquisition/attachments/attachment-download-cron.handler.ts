import { NextResponse } from "next/server"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { getAttachmentDownloadCronConfig } from "@/lib/acquisition/attachments/attachment-download-cron-feature-flag"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { runAcquisitionAttachmentDownloadOrchestrator } from "@/lib/acquisition/attachments/attachment-download-orchestrator"
import type { AttachmentDownloadCronRunResult } from "@/lib/acquisition/attachments/attachment-download-orchestrator.types"

export interface AttachmentDownloadCronRouteDeps {
  runOrchestrator?: () => Promise<AttachmentDownloadCronRunResult>
}

async function defaultRunOrchestrator(): Promise<AttachmentDownloadCronRunResult> {
  return runAcquisitionAttachmentDownloadOrchestrator({
    repository: acquisitionAttachmentRepository,
    downloadAttachment: (input) => downloadAcquisitionAttachment(input),
    createRunId: () => crypto.randomUUID(),
    config: getAttachmentDownloadCronConfig(),
  })
}

export async function handleAcquisitionAttachmentDownloadCron(
  req: Request,
  deps: AttachmentDownloadCronRouteDeps = {}
): Promise<Response> {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const result = await (deps.runOrchestrator ?? defaultRunOrchestrator)()
  return NextResponse.json(result)
}
