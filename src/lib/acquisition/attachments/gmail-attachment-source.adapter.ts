import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
import { PrismaGmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
import { isGmailProviderError } from "@/lib/acquisition/connector/gmail-api.client"
import {
  decodeBase64Url,
} from "@/lib/acquisition/attachments/attachment-policy"
import type {
  GmailAttachmentFetchInput,
  GmailAttachmentFetchResult,
} from "@/lib/acquisition/attachments/attachment.types"

export interface GmailAttachmentSourcePort {
  fetchAttachment(input: GmailAttachmentFetchInput): Promise<GmailAttachmentFetchResult>
}

export class GmailAttachmentSourceAdapter implements GmailAttachmentSourcePort {
  constructor(
    private readonly connection: GmailConnectionClient = new PrismaGmailConnectionClient(),
    private readonly gmail: GmailApiClient = new FetchGmailApiClient()
  ) {}

  async fetchAttachment(input: GmailAttachmentFetchInput): Promise<GmailAttachmentFetchResult> {
    if (!input.companyId || !input.externalMessageId || !input.externalAttachmentId) {
      throw new Error("GMAIL_ATTACHMENT_NOT_FOUND")
    }

    let accessToken: string
    try {
      accessToken = await this.connection.getValidAccessToken(input.companyId)
    } catch (error) {
      if (isGmailProviderError(error) && error.code === "GMAIL_NOT_CONNECTED") {
        throw new Error("GMAIL_NOT_CONNECTED")
      }
      throw error
    }

    let resource
    try {
      resource = await this.gmail.getAttachment(
        accessToken,
        input.externalMessageId,
        input.externalAttachmentId
      )
    } catch (error) {
      if (isGmailProviderError(error)) {
        throw new Error("GMAIL_ATTACHMENT_NOT_FOUND")
      }
      throw error
    }

    if (!resource?.data) {
      throw new Error("GMAIL_ATTACHMENT_NOT_FOUND")
    }

    try {
      const data = decodeBase64Url(resource.data)
      return {
        data,
        sizeBytes: resource.size ?? data.length,
      }
    } catch {
      throw new Error("ATTACHMENT_DECODE_FAILED")
    }
  }
}

export const gmailAttachmentSource = new GmailAttachmentSourceAdapter()
