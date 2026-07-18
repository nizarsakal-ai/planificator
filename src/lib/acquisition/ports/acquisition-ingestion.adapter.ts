import {
  isAcquisitionEnabled,
  registerIncomingMessage,
} from "@/lib/acquisition/acquisition.service"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"

/** Adapter léger : délègue à la fondation existante. */
export const acquisitionIngestionAdapter: AcquisitionIngestionPort = {
  isEnabled: () => isAcquisitionEnabled(),
  registerIncomingMessage: (input) => registerIncomingMessage(input),
}
