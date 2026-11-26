import { createHash } from "node:crypto"

export const MAX_EML_BYTES = 10 * 1024 * 1024
const MAX_HEADER_BYTES = 64 * 1024
const MAX_ATTACHMENTS = 50
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

type ParsedEml = {
  sha256: string
  senderAddress: string
  recipientAddresses: string[]
  subject: string
  text: string
  attachments: Array<{
    filename: string | null
    mimeType: string
    bytes: Uint8Array
  }>
}

type EmlParseResult =
  | { ok: true; message: ParsedEml }
  | { ok: false; code: "EML_TOO_LARGE" | "EML_INVALID" | "EML_ATTACHMENT_LIMIT" }

export async function parseEml(raw: Uint8Array): Promise<EmlParseResult> {
  if (raw.byteLength > MAX_EML_BYTES) return { ok: false, code: "EML_TOO_LARGE" }

  // Ne cherche la séparation en-têtes/corps que dans la fenêtre autorisée.
  const header = Buffer.from(raw.subarray(0, MAX_HEADER_BYTES + 4)).toString("latin1")
  const boundary = header.search(/\r?\n\r?\n/)
  if (boundary <= 0 || boundary > MAX_HEADER_BYTES || raw.includes(0)) {
    return { ok: false, code: "EML_INVALID" }
  }

  try {
    const { default: PostalMime, addressParser } = await import("postal-mime")
    const email = await PostalMime.parse(raw, {
      forceRfc822Attachments: true,
      maxNestingDepth: 12,
      maxHeadersSize: MAX_HEADER_BYTES,
    })
    const from = email.headers.filter(({ key }) => key === "from")
    const senders = from.length === 1 ? addressParser(from[0].value, { flatten: true }) : []
    const senderAddress = senders[0]?.address
    if (senders.length !== 1 || !senderAddress || !/^[^\s@<>]+@[^\s@<>]+$/.test(senderAddress)) {
      return { ok: false, code: "EML_INVALID" }
    }

    if (email.attachments.length > MAX_ATTACHMENTS) {
      return { ok: false, code: "EML_ATTACHMENT_LIMIT" }
    }

    let attachmentBytes = 0
    const attachments: ParsedEml["attachments"] = []
    for (const { filename, mimeType, content } of email.attachments) {
      if (typeof content === "string") return { ok: false, code: "EML_INVALID" }
      const bytes = content instanceof Uint8Array ? content : new Uint8Array(content)
      attachmentBytes += bytes.byteLength
      if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
        return { ok: false, code: "EML_ATTACHMENT_LIMIT" }
      }
      attachments.push({ filename, mimeType, bytes })
    }

    const recipientAddresses = (email.to ?? [])
      .flatMap((address) => address.group?.map((member) => member.address) ?? (address.address ? [address.address] : []))
    return {
      ok: true,
      message: {
        sha256: createHash("sha256").update(raw).digest("hex"),
        senderAddress,
        recipientAddresses,
        subject: email.subject ?? "",
        text: email.text ?? "",
        attachments,
      },
    }
  } catch {
    return { ok: false, code: "EML_INVALID" }
  }
}
