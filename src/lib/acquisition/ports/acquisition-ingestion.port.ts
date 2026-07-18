import type {
  RegisterIncomingMessageInput,
} from "@/lib/validations/acquisition"
import type { RegisterIncomingMessageResult } from "@/lib/acquisition/acquisition.service"

/** Contrat d'ingestion vers la fondation Acquisition — sans Prisma exposé. */
export interface AcquisitionIngestionPort {
  isEnabled(): boolean
  registerIncomingMessage(
    input: RegisterIncomingMessageInput
  ): Promise<RegisterIncomingMessageResult>
}
