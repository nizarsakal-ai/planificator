import {
  ATTACHMENT_READING_TONE_CLASS,
  type AttachmentReadingView,
} from "@/lib/acquisition/review/consultation-ui"
import { cn } from "@/lib/utils"

/** PLAN-ACQ-MULTIMODAL — Issue de lecture d'une pièce jointe (dernière extraction). */
export function AttachmentReadingBadge({ reading }: { reading: AttachmentReadingView }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-xs",
        ATTACHMENT_READING_TONE_CLASS[reading.tone]
      )}
      data-reading-outcome={reading.outcome}
    >
      {reading.label}
    </span>
  )
}
