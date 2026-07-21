import { handleAcquisitionAttachmentRecoveryCron } from "@/lib/acquisition/attachments/attachment-recovery-cron.handler"

/**
 * Budget Vercel (Pro) : couvre `ACQUISITION_ATTACHMENT_RECOVERY_MAX_DURATION_MS` (défaut 240s)
 * avec marge réseau/cold start.
 */
export const maxDuration = 300

/** GET /api/cron/acquisition-attachment-recovery — reclaim + retry (inactif par défaut via flags). */
export async function GET(req: Request) {
  return handleAcquisitionAttachmentRecoveryCron(req)
}
