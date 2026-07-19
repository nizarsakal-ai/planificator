import { NextResponse } from "next/server"
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
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

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
