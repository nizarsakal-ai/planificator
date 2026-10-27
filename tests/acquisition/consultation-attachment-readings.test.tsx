/**
 * PLAN-ACQ-MULTIMODAL — UI consultation : issue de lecture par pièce jointe.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { mapAttachmentReadOutcomes } from "@/lib/acquisition/review/consultation-ui"
import { AttachmentReadingBadge } from "@/components/consultations/AttachmentReadingBadge"

// tsconfig "jsx": "preserve" → sous tsx, JSX compilé en React.createElement (runtime classique).
;(globalThis as { React?: typeof React }).React = React

describe("mapAttachmentReadOutcomes", () => {
  it("libellés FR par issue, raison courte, codes inconnus ignorés", () => {
    const views = mapAttachmentReadOutcomes({
      attachmentReadOutcomes: [
        { filename: "BC.pdf", kind: "pdf", outcome: "READ_TEXT" },
        { filename: "scan.pdf", kind: "pdf", outcome: "READ_VISION" },
        { filename: "IMG_2635.jpeg", kind: "image", outcome: "IGNORED_VISION_DISABLED", reason: "FLAG_OFF" },
        { filename: "IMG_1.HEIC", kind: "heic", outcome: "IGNORED_HEIC", reason: "HEIC_NOT_SUPPORTED" },
        { filename: "p6.jpg", kind: "image", outcome: "IGNORED_TOO_LARGE", reason: "MAX_VISUAL_FILES" },
        { filename: "plan.dwg", kind: "other", outcome: "IGNORED_FORMAT" },
        { filename: "x", outcome: "<script>alert(1)</script>" },
        "garbage",
        { outcome: "READ_TEXT" },
      ],
    })
    assert.deepEqual(
      views.map((v) => [v.filename, v.label, v.tone]),
      [
        ["BC.pdf", "Lu (texte)", "ok"],
        ["scan.pdf", "Lu (vision)", "ok"],
        ["IMG_2635.jpeg", "Ignoré : lecture visuelle désactivée (flag OFF)", "muted"],
        ["IMG_1.HEIC", "Ignoré : photo HEIC (demander un JPEG)", "warn"],
        ["p6.jpg", "Ignoré : trop gros (plus de 5 fichiers visuels)", "warn"],
        ["plan.dwg", "Ignoré : format non pris en charge", "muted"],
      ]
    )
  })

  it("extractedData historique (sans issues) → liste vide", () => {
    assert.deepEqual(mapAttachmentReadOutcomes(null), [])
    assert.deepEqual(mapAttachmentReadOutcomes({ schemaVersion: "2" }), [])
    assert.deepEqual(mapAttachmentReadOutcomes([]), [])
  })
})

describe("AttachmentReadingBadge", () => {
  it("rendu sobre : libellé catalogue + classe de ton", () => {
    const html = renderToStaticMarkup(
      <AttachmentReadingBadge
        reading={{ filename: "<b>x</b>", outcome: "READ_VISION", label: "Lu (vision)", tone: "ok" }}
      />
    )
    assert.match(html, /Lu \(vision\)/)
    assert.match(html, /bg-green-100/)
    assert.match(html, /data-reading-outcome="READ_VISION"/)
  })
})

describe("ConsultationDetail / formulaire — câblage", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

  it("le détail affiche l'issue par pièce jointe et les issues orphelines", () => {
    const src = read("src/components/consultations/ConsultationDetail.tsx")
    assert.match(src, /bundle\.attachmentReadings/)
    assert.match(src, /<AttachmentReadingBadge reading=\{reading\} \/>/)
    assert.match(src, /Lecture des pièces jointes/)
  })

  it("la relance affiche les avertissements de récupération (toast.warning)", () => {
    const src = read("src/components/consultations/ConsultationProposedForm.tsx")
    assert.match(src, /toast\.warning\(w\)/)
  })

  it("le repository de lecture expose les issues depuis extractedData", () => {
    const src = read("src/lib/acquisition/review/import-draft-read.repository.ts")
    assert.match(src, /extractedData: true/)
    assert.match(src, /attachmentReadings: mapAttachmentReadOutcomes\(draft\.extractedData\)/)
  })
})
