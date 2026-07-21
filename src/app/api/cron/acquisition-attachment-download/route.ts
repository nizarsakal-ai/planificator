import { handleAcquisitionAttachmentDownloadCron } from "@/lib/acquisition/attachments/attachment-download-cron.handler"

/**
 * Budget Vercel (Pro) : couvre `ACQUISITION_ATTACHMENT_CRON_MAX_DURATION_MS` (défaut 240s)
 * avec marge réseau/cold start.
 */
export const maxDuration = 300

/** GET /api/cron/acquisition-attachment-download — orchestrateur download PJ (inactif par défaut via flags). */
export async function GET(req: Request) {
  return handleAcquisitionAttachmentDownloadCron(req)
}
