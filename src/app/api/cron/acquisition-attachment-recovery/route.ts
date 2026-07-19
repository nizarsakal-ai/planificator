import { handleAcquisitionAttachmentRecoveryCron } from "@/lib/acquisition/attachments/attachment-recovery-cron.handler"

/** GET /api/cron/acquisition-attachment-recovery — reclaim + retry (inactif par défaut). */
export async function GET(req: Request) {
  return handleAcquisitionAttachmentRecoveryCron(req)
}
