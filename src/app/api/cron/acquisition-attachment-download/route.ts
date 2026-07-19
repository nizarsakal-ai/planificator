import { handleAcquisitionAttachmentDownloadCron } from "@/lib/acquisition/attachments/attachment-download-cron.handler"

/** GET /api/cron/acquisition-attachment-download — orchestrateur download PJ (inactif par défaut). */
export async function GET(req: Request) {
  return handleAcquisitionAttachmentDownloadCron(req)
}
