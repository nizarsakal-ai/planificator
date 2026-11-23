import type { AttachmentSourcePort } from "@/lib/acquisition/attachments/attachment-source.port"
import { gmailAttachmentSource } from "@/lib/acquisition/attachments/gmail-attachment-source.adapter"
import { gmailMessageContentSource } from "@/lib/acquisition/content/gmail-message-content-source.adapter"
import type { AcquisitionMessageContentSourcePort } from "@/lib/acquisition/content/message-content-source.port"
import { isGmailProviderError } from "@/lib/acquisition/connector/gmail-api.client"

// Composition des adaptateurs historiques. La résolution par capacité sera
// introduite lorsque le lien entre message et connexion sera disponible.
export const legacyMailArtifactSources: {
  content: AcquisitionMessageContentSourcePort
  attachment: AttachmentSourcePort
  contentFailureCode(error: unknown): string | undefined
} = {
  content: gmailMessageContentSource,
  attachment: gmailAttachmentSource,
  contentFailureCode: error => isGmailProviderError(error) ? error.code : undefined,
}
