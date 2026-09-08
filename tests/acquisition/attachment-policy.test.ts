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

  it("rejette octet-stream hors DWG/DXF et hors image magic", () => {
    const r = validateAttachmentContent({
      filename: "file.bin",
      declaredMimeType: "application/octet-stream",
      buffer: Buffer.from("random"),
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_MIME_NOT_ALLOWED")
  })

  it("L2 : octet-stream + .jpeg + magic JPEG → accepté (MIME normalisé)", () => {
    const r = validateAttachmentContent({
      filename: "photo.jpeg",
      declaredMimeType: "application/octet-stream",
      buffer: JPEG_BUFFER,
    })
    assert.equal(r.allowed, true)
    assert.equal(r.resolvedMimeType, "image/jpeg")
  })

  it("L2 : octet-stream + .jpg + magic JPEG → accepté", () => {
    const r = validateAttachmentContent({
      filename: "photo.jpg",
      declaredMimeType: "application/octet-stream",
      buffer: JPEG_BUFFER,
    })
    assert.equal(r.allowed, true)
    assert.equal(r.resolvedMimeType, "image/jpeg")
  })

  it("L2 : octet-stream + .png + magic PNG → accepté", () => {
    const r = validateAttachmentContent({
      filename: "scan.png",
      declaredMimeType: "application/octet-stream",
      buffer: PNG_BUFFER,
    })
    assert.equal(r.allowed, true)
    assert.equal(r.resolvedMimeType, "image/png")
  })

  it("L2 : octet-stream + .jpg + magic PNG → rejeté", () => {
    const r = validateAttachmentContent({
      filename: "photo.jpg",
      declaredMimeType: "application/octet-stream",
      buffer: PNG_BUFFER,
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_SIGNATURE_MISMATCH")
  })

  it("L2 : octet-stream + .png + magic JPEG → rejeté", () => {
    const r = validateAttachmentContent({
      filename: "scan.png",
      declaredMimeType: "application/octet-stream",
      buffer: JPEG_BUFFER,
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_SIGNATURE_MISMATCH")
  })

  it("L2 : octet-stream + .jpg + HTML actif → rejeté", () => {
    const r = validateAttachmentContent({
      filename: "photo.jpg",
      declaredMimeType: "application/octet-stream",
      buffer: Buffer.from("<!DOCTYPE html><html>"),
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_MIME_NOT_ALLOWED")
  })

  it("L2 : octet-stream sans extension image → rejeté", () => {
    const r = validateAttachmentContent({
      filename: "blob.dat",
      declaredMimeType: "application/octet-stream",
      buffer: JPEG_BUFFER,
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_MIME_NOT_ALLOWED")
  })

  it("PPTX MIME hors allowlist → rejeté (comportement conservé)", () => {
    const r = validateAttachmentContent({
      filename: "deck.pptx",
      declaredMimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
    })
    assert.equal(r.allowed, false)
    assert.equal(r.errorCode, "ATTACHMENT_MIME_NOT_ALLOWED")
  })

  it("XLSX MIME correct + magic ZIP → accepté (pas d’extraction texte L2)", () => {
    const r = validateAttachmentContent({
      filename: "grid.xlsx",
      declaredMimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
    })
    assert.equal(r.allowed, true)
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
