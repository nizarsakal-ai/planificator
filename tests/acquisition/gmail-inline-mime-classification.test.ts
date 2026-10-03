/**
 * Images MIME inline embarquées (cid:) — exclues des pièces jointes uniquement si
 * image/* + disposition-type « inline » + Content-ID non vide. Tout cas ambigu reste attachment.
 * Données fictives uniquement ; aucun appel Gmail / OAuth / DB.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  extractAttachmentMetadataFromPayload,
  isEmbeddedInlineImage,
} from "@/lib/acquisition/connector/gmail-mime-parser"
import { sanitizePayloadForMetadata } from "@/lib/acquisition/connector/gmail-message-sanitizer"
import { GmailMailProviderAdapter } from "@/lib/acquisition/connector/gmail-mail-provider.adapter"
import type { GmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"
import type { GmailMessagePart, GmailMessageResource } from "@/lib/acquisition/connector/gmail-api.types"

type H = { name: string; value: string }

function part(input: {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: H[]
  attachmentId?: string
  size?: number
  parts?: GmailMessagePart[]
}): GmailMessagePart {
  return {
    partId: input.partId ?? "1",
    mimeType: input.mimeType ?? "image/png",
    filename: input.filename ?? "image006.png",
    headers: input.headers ?? [],
    body: {
      size: input.size ?? 1234,
      ...(input.attachmentId !== undefined ? { attachmentId: input.attachmentId } : {}),
    },
    ...(input.parts ? { parts: input.parts } : {}),
  }
}

const INLINE = (name = "image006.png"): H => ({ name: "Content-Disposition", value: `inline; filename="${name}"` })
const CID = (v = "<image006.png@01DC0000.00000000>"): H => ({ name: "Content-ID", value: v })

function names(payload: GmailMessagePart): string[] {
  return extractAttachmentMetadataFromPayload({ mimeType: "multipart/mixed", parts: [payload] }).map(
    (a) => a.filename
  )
}

describe("isEmbeddedInlineImage — politique 3 conditions", () => {
  it("1. image/png + inline + CID + filename + attachmentId → exclue", () => {
    const p = part({ headers: [INLINE(), CID()], attachmentId: "ATT-1" })
    assert.equal(isEmbeddedInlineImage(p), true)
    assert.deepEqual(names(p), [])
  })

  it("2. inline sans Content-ID → conservée", () => {
    for (const headers of [[INLINE()], [INLINE(), CID("")], [INLINE(), CID("   ")]]) {
      const p = part({ headers, attachmentId: "ATT-1" })
      assert.equal(isEmbeddedInlineImage(p), false)
      assert.deepEqual(names(p), ["image006.png"])
    }
  })

  it("3. attachment + Content-ID → conservée", () => {
    const p = part({
      headers: [{ name: "Content-Disposition", value: 'attachment; filename="photo.jpg"' }, CID()],
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      attachmentId: "ATT-2",
    })
    assert.equal(isEmbeddedInlineImage(p), false)
    assert.deepEqual(names(p), ["photo.jpg"])
  })

  it("4. Content-Disposition absent + filename → conservée (même avec CID)", () => {
    for (const headers of [[], [CID()]]) {
      const p = part({ headers, filename: "chantier.png" })
      assert.equal(isEmbeddedInlineImage(p), false)
      assert.deepEqual(names(p), ["chantier.png"])
    }
  })

  it("5. Content-Disposition absent + attachmentId seul → conservée", () => {
    const p: GmailMessagePart = { partId: "1", mimeType: "image/png", body: { attachmentId: "ATT-3", size: 10 } }
    assert.equal(isEmbeddedInlineImage(p), false)
    assert.deepEqual(names(p), ["attachment-ATT-3"])
  })

  it("6. inline + CID + application/pdf → conservée (un PDF peut être un PLAN)", () => {
    const p = part({ headers: [INLINE("plan.pdf"), CID()], filename: "plan.pdf", mimeType: "application/pdf", attachmentId: "ATT-4" })
    assert.equal(isEmbeddedInlineImage(p), false)
    assert.deepEqual(names(p), ["plan.pdf"])
  })

  it("7. dispositions malformées / inconnues → conservées", () => {
    for (const value of ["", "   ", ";inline", "inline-x", "inlines; filename=a.png", "in line", "attachment", "inline=1", "inlin"]) {
      const p = part({ headers: [{ name: "Content-Disposition", value }, CID()] })
      assert.equal(isEmbeddedInlineImage(p), false, JSON.stringify(value))
      assert.deepEqual(names(p), ["image006.png"], JSON.stringify(value))
    }
  })

  it("7. mimeType absent / non image → conservée", () => {
    for (const mimeType of [undefined, "", "application/octet-stream", "text/html", "xImage/png"]) {
      const p: GmailMessagePart = { ...part({ headers: [INLINE(), CID()] }), mimeType }
      assert.equal(isEmbeddedInlineImage(p), false, String(mimeType))
    }
  })

  it("8. casse des noms et des valeurs de headers / mimeType", () => {
    for (const [cdName, cdValue, cidName, mime] of [
      ["content-disposition", "inline; filename=a.png", "content-id", "image/png"],
      ["CONTENT-DISPOSITION", "INLINE; FILENAME=A.PNG", "CONTENT-ID", "IMAGE/PNG"],
      ["Content-disposition", "Inline", "Content-Id", "Image/Jpeg"],
      ["Content-Disposition", "  inline  ; filename=a.png", "Content-ID", " image/gif "],
    ]) {
      const p = part({ mimeType: mime, headers: [{ name: cdName, value: cdValue }, { name: cidName, value: "<x@y>" }] })
      assert.equal(isEmbeddedInlineImage(p), true, `${cdName}/${cdValue}/${cidName}/${mime}`)
    }
  })

  it("9. « inline;filename=x.png » sans espace → exclue", () => {
    const p = part({ headers: [{ name: "Content-Disposition", value: "inline;filename=x.png" }, CID()] })
    assert.equal(isEmbeddedInlineImage(p), true)
  })

  it("10. Content-ID sans chevrons → exclue", () => {
    const p = part({ headers: [INLINE(), CID("image006.png@01DC0000")] })
    assert.equal(isEmbeddedInlineImage(p), true)
  })

  it("11. headers dupliqués → premier header retenu (comportement getGmailHeader)", () => {
    const firstInline = part({
      headers: [INLINE(), { name: "content-disposition", value: "attachment" }, CID()],
    })
    assert.equal(isEmbeddedInlineImage(firstInline), true)
    const firstAttachment = part({
      headers: [{ name: "Content-Disposition", value: "attachment" }, INLINE(), CID()],
    })
    assert.equal(isEmbeddedInlineImage(firstAttachment), false)
    const firstCidEmpty = part({ headers: [INLINE(), CID(""), CID("<x@y>")] })
    assert.equal(isEmbeddedInlineImage(firstCidEmpty), false)
  })

  it("12. enfants d'une part exclue toujours parcourus", () => {
    const parent = part({
      partId: "1",
      headers: [INLINE(), CID()],
      attachmentId: "ATT-P",
      parts: [
        {
          partId: "1.1",
          mimeType: "application/pdf",
          filename: "nested-plan.pdf",
          headers: [{ name: "Content-Disposition", value: "attachment" }],
          body: { attachmentId: "ATT-C", size: 99 },
        },
      ],
    })
    assert.deepEqual(names(parent), ["nested-plan.pdf"])
  })
})

/** Fixture Outlook-like : 6 logos de signature inline + 1 vrai PDF + 1 vrai JPG. */
function outlookLikeMessage(): GmailMessageResource {
  const inlineImages: GmailMessagePart[] = [6, 7, 8, 9, 10, 11].map((n, i) => {
    const name = `image0${String(n).padStart(2, "0")}.png`
    return {
      partId: `0.${i + 1}`,
      mimeType: "image/png",
      filename: name,
      headers: [
        { name: "Content-Type", value: `image/png; name="${name}"` },
        { name: "Content-Description", value: name },
        { name: "Content-Disposition", value: `inline; filename="${name}"; size=1234` },
        { name: "Content-ID", value: `<${name}@01DC1234.ABCDEF00>` },
        { name: "Content-Transfer-Encoding", value: "base64" },
      ],
      body: { attachmentId: `ATT-INLINE-${n}`, size: 1234 + n, data: "aW5saW5lLWJ5dGVz" },
    }
  })
  return {
    id: "gmail-outlook-1",
    threadId: "thread-outlook",
    internalDate: "1720000000000",
    snippet: "Bonjour",
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "contact@partner.test" },
        { name: "Subject", value: "Consultation" },
        { name: "Date", value: "Wed, 03 Jul 2024 10:00:00 +0000" },
        { name: "Message-ID", value: "<outlook@partner.test>" },
        { name: "X-MS-Has-Attach", value: "yes" },
      ],
      parts: [
        {
          partId: "0",
          mimeType: "multipart/related",
          headers: [{ name: "Content-Type", value: "multipart/related" }],
          body: { size: 0 },
          parts: [
            {
              partId: "0.0",
              mimeType: "multipart/alternative",
              body: { size: 0 },
              parts: [
                { partId: "0.0.0", mimeType: "text/plain", body: { size: 100, data: "Ym9keQ==" } },
                { partId: "0.0.1", mimeType: "text/html", body: { size: 300, data: "PGh0bWw+" } },
              ],
            },
            ...inlineImages,
          ],
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "plan-niveau-1.pdf",
          headers: [
            { name: "Content-Disposition", value: 'attachment; filename="plan-niveau-1.pdf"' },
            { name: "Content-ID", value: "<pdf@01DC1234>" },
          ],
          body: { attachmentId: "ATT-PDF", size: 250000 },
        },
        {
          partId: "2",
          mimeType: "image/jpeg",
          filename: "photo-facade.jpg",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="photo-facade.jpg"' }],
          body: { attachmentId: "ATT-JPG", size: 800000 },
        },
      ],
    },
  }
}

describe("13. fixture Outlook-like", () => {
  it("image006 → image011 inline + CID + attachmentId exclues ; seuls PDF + JPG ressortent", () => {
    const attachments = extractAttachmentMetadataFromPayload(sanitizePayloadForMetadata(outlookLikeMessage().payload))
    assert.deepEqual(
      attachments.map((a) => ({ filename: a.filename, externalAttachmentId: a.externalAttachmentId, mimeType: a.mimeType })),
      [
        { filename: "plan-niveau-1.pdf", externalAttachmentId: "ATT-PDF", mimeType: "application/pdf" },
        { filename: "photo-facade.jpg", externalAttachmentId: "ATT-JPG", mimeType: "image/jpeg" },
      ]
    )
  })

  it("sans sanitization des headers de sous-parts, le même payload laissait passer les 8 parts (cause racine)", () => {
    const stripped = JSON.parse(JSON.stringify(outlookLikeMessage().payload), (k, v) =>
      k === "headers" ? undefined : v
    )
    assert.equal(extractAttachmentMetadataFromPayload(stripped).length, 8)
  })
})

describe("14. sanitizer — Content-Disposition / Content-ID uniquement sur les sous-parts", () => {
  const raw = outlookLikeMessage().payload!

  it("sous-parts : seuls Content-Disposition et Content-ID conservés", () => {
    const sanitized = sanitizePayloadForMetadata(raw)!
    const visit = (p: GmailMessagePart): void => {
      for (const h of p.headers ?? []) {
        assert.ok(["content-disposition", "content-id"].includes(h.name.toLowerCase()), h.name)
      }
      for (const c of p.parts ?? []) visit(c)
    }
    for (const p of sanitized.parts ?? []) visit(p)
    const img = sanitized.parts![0]!.parts![1]!
    assert.deepEqual(img.headers, [
      { name: "Content-Disposition", value: 'inline; filename="image006.png"; size=1234' },
      { name: "Content-ID", value: "<image006.png@01DC1234.ABCDEF00>" },
    ])
  })

  it("sous-parts : Subject / From / X-* / Content-Type retirés ; aucune clé headers si rien d'autorisé", () => {
    const sanitized = sanitizePayloadForMetadata({
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "0",
          mimeType: "message/rfc822",
          headers: [
            { name: "Subject", value: "SUBPART-SUBJECT" },
            { name: "From", value: "subpart-from@x.test" },
            { name: "X-Secret", value: "SUBPART-X" },
            { name: "Content-Type", value: "text/plain" },
          ],
          body: { size: 1, data: "c2VjcmV0" },
        },
      ],
    })!
    const serialized = JSON.stringify(sanitized)
    for (const s of ["SUBPART-SUBJECT", "subpart-from", "SUBPART-X", "Content-Type", "c2VjcmV0"]) {
      assert.ok(!serialized.includes(s), s)
    }
    assert.equal("headers" in sanitized.parts![0]!, false)
  })

  it("body.data toujours retiré, partout", () => {
    const serialized = JSON.stringify(sanitizePayloadForMetadata(raw))
    for (const s of ['"data"', "aW5saW5lLWJ5dGVz", "Ym9keQ==", "PGh0bWw+"]) {
      assert.ok(!serialized.includes(s), s)
    }
  })

  it("root : whitelist existante inchangée (From/Subject/Date/Message-ID ; ni Content-Disposition ni X-*)", () => {
    const sanitized = sanitizePayloadForMetadata({
      mimeType: "image/png",
      filename: "root.png",
      headers: [
        { name: "From", value: "a@b.test" },
        { name: "Content-Disposition", value: "inline" },
        { name: "Content-ID", value: "<root@x>" },
        { name: "X-MS-Has-Attach", value: "yes" },
        { name: "Subject", value: "S" },
      ],
    })!
    assert.deepEqual(sanitized.headers!.map((h) => h.name), ["From", "Subject"])
  })
})

describe("15. adapter end-to-end — payload FULL brut → modèle canonique", () => {
  it("les 6 images inline sont absentes des attachments ; PDF + JPG présents ; aucun CID/header exposé", async () => {
    const apiClient: GmailApiClient = {
      getProfile: async () => ({ historyId: "h1" }),
      listHistory: async () => ({ history: [], historyId: "h1" }),
      listMessages: async () => ({ messages: [{ id: "gmail-outlook-1" }] }),
      getMessage: async () => outlookLikeMessage(),
      getAttachment: async () => {
        throw new Error("getAttachment MUST NOT BE CALLED")
      },
    }
    const adapter = new GmailMailProviderAdapter({
      connectionClient: { getValidAccessToken: async () => "fict-token" },
      apiClient,
      domainListing: {
        listActiveIdentities: async () => ({ domains: ["partner.test"], emails: [] }),
        listActiveDomains: async () => ["partner.test"],
      },
    })
    const page = await adapter.listMessagesPage({ companyId: "co-1", connectionId: "conn-1", cursor: null, pageSize: 5 })
    const msg = page.messages[0]!
    assert.deepEqual(msg.attachments.map((a) => a.filename), ["plan-niveau-1.pdf", "photo-facade.jpg"])
    const serialized = JSON.stringify(msg)
    for (const s of ["image006", "image011", "ATT-INLINE", "01DC1234", "Content-ID", "Content-Disposition", "aW5saW5l"]) {
      assert.ok(!serialized.includes(s), s)
    }
  })
})
