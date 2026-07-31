import { NextResponse } from "next/server"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { acquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { getAttachmentRecoveryCronConfig } from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"
import { runAcquisitionAttachmentRecoveryOrchestrator } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator"
import type { AttachmentRecoveryCronRunResult } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"

export interface AttachmentRecoveryCronRouteDeps {
  runOrchestrator?: () => Promise<AttachmentRecoveryCronRunResult>
}

async function defaultRunOrchestrator(): Promise<AttachmentRecoveryCronRunResult> {
  return runAcquisitionAttachmentRecoveryOrchestrator({
    repository: acquisitionAttachmentRepository,
    createRunId: () => crypto.randomUUID(),
    config: getAttachmentRecoveryCronConfig(),
  })
}

export async function handleAcquisitionAttachmentRecoveryCron(
  req: Request,
  deps: AttachmentRecoveryCronRouteDeps = {}
): Promise<Response> {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  try {
    const result = await (deps.runOrchestrator ?? defaultRunOrchestrator)()
    return NextResponse.json(result)
  } catch {
    return NextResponse.json(
      { error: "Attachment recovery cron failed", code: "ATTACHMENT_RECOVERY_CRON_FAILED" },
      { status: 500 }
    )
  }
}
