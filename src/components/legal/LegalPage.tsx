import { LegalDocumentView } from "@/components/legal/LegalDocumentView"
import type { LegalDocumentKey } from "@/lib/legal/legal-documents"
import { loadLegalDocument } from "@/lib/legal/load-legal-document"

// Lot 2a juridique : une page légale = le texte de docs/legal, avec un avertissement tant qu'il reste des champs à remplir.
export function LegalPage({ documentKey }: { documentKey: LegalDocumentKey }) {
  const doc = loadLegalDocument(documentKey)
  return (
    <>
      {doc.incomplete && (
        <p role="note" className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Document en cours de finalisation : certaines informations restent à compléter.
        </p>
      )}
      <LegalDocumentView blocks={doc.blocks} />
    </>
  )
}
