process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  decodeBase64Url,
  validateAttachmentContent,
} from "@/lib/acquisition/attachments/attachment-policy"

const PDF_BUFFER = Buffer.from("%PDF-1.4 test content")
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
])

describe("attachment-policy", () => {
  it("accepte un PDF valide", () => {
    const r = validateAttachmentContent({
      filename: "plan.pdf",
      declaredMimeType: "application/pdf",
      buffer: PDF_BUFFER,
    })
    assert.equal(r.allowed, true)
  })

  it("accepte un JPEG valide", () => {
    const r = validateAttachmentContent({
      filename: "photo.jpg",
      declaredMimeType: "image/jpeg",
      buffer: JPEG_BUFFER,
    })
    assert.equal(r.allowed, true)
  })

  it("accepte un PNG valide", () => {
    const r = validateAttachmentContent({
      filename: "scan.png",
      declaredMimeType: "image/png",
      buffer: PNG_BUFFER,
    })
    assert.equal(r.allowed, true)
  })

  it("rejette faux PDF (hello + application/pdf + plan.pdf)", () => {
    const r = validateAttachmentContent({
      filename: "plan.pdf",
      declaredMimeType: "application/pdf",
      buffer: Buffer.from("hello"),
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_SIGNATURE_MISMATCH")
  })

  it("rejette faux JPEG", () => {
    const r = validateAttachmentContent({
      filename: "photo.jpg",
      declaredMimeType: "image/jpeg",
      buffer: Buffer.from("plain text"),
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_SIGNATURE_MISMATCH")
  })

  it("rejette faux PNG", () => {
    const r = validateAttachmentContent({
      filename: "scan.png",
      declaredMimeType: "image/png",
      buffer: Buffer.from("plain text"),
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_SIGNATURE_MISMATCH")
  })

  it("rejette MIME inconnu", () => {
    const r = validateAttachmentContent({
      filename: "data.json",
      declaredMimeType: "application/json",
      buffer: Buffer.from("{}"),
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_MIME_NOT_ALLOWED")
  })

  it("rejette octet-stream hors DWG/DXF", () => {
    const r = validateAttachmentContent({
      filename: "file.bin",
      declaredMimeType: "application/octet-stream",
      buffer: Buffer.from("random"),
    })
    assert.equal(r.allowed, false)
  })

  it("rejette extension trompeuse (.exe)", () => {
    const r = validateAttachmentContent({
      filename: "plan.exe",
      declaredMimeType: "application/pdf",
      buffer: PDF_BUFFER,
    })
    assert.equal(r.allowed, false)
  })

  it("rejette signature incohérente PDF déclaré PNG réel", () => {
    const r = validateAttachmentContent({
      filename: "plan.pdf",
      declaredMimeType: "application/pdf",
      buffer: PNG_BUFFER,
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_SIGNATURE_MISMATCH")
  })

  it("decode base64url Gmail", () => {
    const raw = Buffer.from("hello")
    const b64url = raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    assert.equal(decodeBase64Url(b64url).toString(), "hello")
  })
})

describe("attachment-policy — octet-stream résolu par signature (PLAN-ACQ-MULTIMODAL)", () => {
  const HEIC = (() => {
    const b = Buffer.alloc(24)
    b.writeUInt32BE(24, 0)
    b.write("ftypheic", 4, "ascii")
    return b
  })()
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])

  it("IMG_2635.jpeg déclaré octet-stream + signature JPEG → autorisé, MIME résolu image/jpeg", () => {
    const r = validateAttachmentContent({
      filename: "IMG_2635.jpeg",
      declaredMimeType: "application/octet-stream",
      buffer: JPEG_BUFFER,
    })
    assert.deepEqual(r, { allowed: true, resolvedMimeType: "image/jpeg" })
  })

  it("PDF / PNG / HEIC / xlsx octet-stream avec extension concordante → autorisés", () => {
    assert.equal(
      validateAttachmentContent({ filename: "bc.pdf", declaredMimeType: "application/octet-stream", buffer: PDF_BUFFER })
        .resolvedMimeType,
      "application/pdf"
    )
    assert.equal(
      validateAttachmentContent({ filename: "p.png", declaredMimeType: "application/octet-stream", buffer: PNG_BUFFER })
        .resolvedMimeType,
      "image/png"
    )
    assert.equal(
      validateAttachmentContent({ filename: "p.HEIC", declaredMimeType: "application/octet-stream", buffer: HEIC })
        .resolvedMimeType,
      "image/heic"
    )
    const x = validateAttachmentContent({
      filename: "TEMPLATE_CROQUIS.xlsx",
      declaredMimeType: "application/octet-stream",
      buffer: ZIP,
    })
    assert.equal(x.allowed, true)
    assert.equal(x.resolvedMimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  })

  it("extension discordante ou type non autorisé → toujours refusé", () => {
    for (const [filename, buffer] of [
      ["photo.png", JPEG_BUFFER],
      ["photo.jpeg.exe", JPEG_BUFFER],
      ["photo", JPEG_BUFFER],
      ["archive.zip", ZIP],
      ["macro.xlsm", ZIP],
      ["page.html", Buffer.from("<!doctype html><script>")],
      ["image.svg", Buffer.from("<svg onload=alert(1)>")],
      ["script.jpg", Buffer.from("#!/bin/sh\nrm -rf /")],
      ["prog.jpg", Buffer.from([0x4d, 0x5a, 0x90, 0x00])],
    ] as const) {
      const r = validateAttachmentContent({
        filename,
        declaredMimeType: "application/octet-stream",
        buffer: Buffer.from(buffer),
      })
      assert.equal(r.allowed, false, filename)
    }
  })
})
