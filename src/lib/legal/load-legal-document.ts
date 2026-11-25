import { readFileSync } from "node:fs"
import { join } from "node:path"
import { legalDocument, legalHref, type LegalDocumentKey } from "@/lib/legal/legal-documents"
import { hasPlaceholders, parseLegalMarkdown, stripDraftNote, type Block } from "@/lib/legal/legal-markdown"

// Lot 2a juridique : lecture d'un texte de docs/legal au moment du rendu statique (pages force-static : lu au build).

export interface LoadedLegalDocument {
  title: string
  blocks: Block[]
  /** Le texte contient encore « [À COMPLÉTER] » ou « [À VÉRIFIER] » : la page affiche un avertissement. */
  incomplete: boolean
}

export function loadLegalDocument(key: LegalDocumentKey): LoadedLegalDocument {
  const doc = legalDocument(key)
  const markdown = readFileSync(join(process.cwd(), "docs", "legal", doc.file), "utf8")
  return {
    title: doc.title,
    blocks: parseLegalMarkdown(stripDraftNote(markdown), legalHref),
    incomplete: hasPlaceholders(markdown),
  }
}
