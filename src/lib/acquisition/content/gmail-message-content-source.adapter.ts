import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import { FetchGmailApiClient, isGmailProviderError } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
import { PrismaGmailConnectionClient } from "@/lib/acquisition/connector/gmail-connection.client"
import { GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import { extractTextPartsFromPayload } from "@/lib/acquisition/content/message-content-mime"
import type {
  AcquisitionMessageContentSourcePort,
  CanonicalMessageBodyParts,
  FetchMessageContentSourceInput,
} from "@/lib/acquisition/content/message-content-source.port"

/**
 * Adapter dédié fetch corps message — distinct du listing sync (GmailMailProviderAdapter).
 * Ne remonte jamais tokens, payload complet, PJ binaires ni body.data au service.
 */
export class GmailMessageContentSourceAdapter implements AcquisitionMessageContentSourcePort {
  constructor(
    private readonly connection: GmailConnectionClient = new PrismaGmailConnectionClient(),
    private readonly gmail: GmailApiClient = new FetchGmailApiClient()
  ) {}

  async fetchMessageBody(input: FetchMessageContentSourceInput): Promise<CanonicalMessageBodyParts> {
    if (!input.companyId?.trim() || !input.externalMessageId?.trim()) {
      throw new GmailProviderError({
        code: "GMAIL_MESSAGE_PARSE_ERROR",
        message: "Identifiants message incomplets",
        retryable: false,
        global: false,
      })
    }

    const accessToken = await this.connection.getValidAccessToken(input.companyId)
    const resource = await this.gmail.getMessage(accessToken, input.externalMessageId)
    const extracted = extractTextPartsFromPayload(resource.payload)

    // Retour volontairement minimal — texte décodé uniquement (pas body.data).
    return {
      textPlain: extracted.textPlain,
      textHtml: extracted.textHtml,
      mimeType: extracted.mimeType,
      charset: extracted.charset,
      providerMessageId: resource.id,
      byteLengthOriginal: extracted.byteLengthOriginal,
    }
  }
}

export const gmailMessageContentSource = new GmailMessageContentSourceAdapter()

export function mapContentSourceError(error: unknown): GmailProviderError {
  if (isGmailProviderError(error)) return error
  return new GmailProviderError({
    code: "GMAIL_UNAVAILABLE",
    message: "Échec récupération contenu Gmail",
    retryable: true,
    global: false,
  })
}
