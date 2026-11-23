import type { AttachmentFetchInput, AttachmentFetchResult } from "@/lib/acquisition/attachments/attachment.types"

export interface AttachmentSourcePort {
  fetchAttachment(input: AttachmentFetchInput): Promise<AttachmentFetchResult>
}
