import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { AcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
import { PrismaAcquisitionGmailConnectionClient } from "@/lib/acquisition/connector/acquisition-gmail-connection.client"
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
    private readonly connection: AcquisitionGmailConnectionClient = new PrismaAcquisitionGmailConnectionClient(),
    private readonly gmail: GmailApiClient = new FetchGmailApiClient()
  ) {}

  async fetchAttachment(input: GmailAttachmentFetchInput): Promise<GmailAttachmentFetchResult> {
    if (!input.companyId || !input.externalMessageId || !input.externalAttachmentId) {
      throw new Error("GMAIL_ATTACHMENT_NOT_FOUND")
    }
    if (!input.connectionId) {
      throw new Error("GMAIL_NOT_CONNECTED")
    }

    let accessToken: string
    try {
      accessToken = await this.connection.getValidAccessToken({
        companyId: input.companyId,
        connectionId: input.connectionId,
      })
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
