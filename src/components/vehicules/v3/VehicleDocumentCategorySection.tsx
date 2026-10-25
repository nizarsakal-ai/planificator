"use client"

import { FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  CATEGORY_HINTS, documentStatusLabel, documentStatusTone, formatBytes, formatDateFr, formatInstantFr, remainingLabel,
  type DocumentView, type DocumentVersionView,
} from "./vehicle-document-ui"
import type { VehicleDocumentCategoryCode } from "@/lib/vehicules/v3/document-domain"

export interface CategorySectionProps {
  truckId: string
  category: { code: VehicleDocumentCategoryCode; label: string }
  active: DocumentView[]
  archived: DocumentView[]
  canManage: boolean
  truckActive: boolean
  busy: boolean
  expandedId: string | null
  versions: Record<string, DocumentVersionView[] | undefined>
  onToggleVersions: (document: DocumentView) => void
  onVerify: (document: DocumentView) => void
  onReplace: (document: DocumentView) => void
  onArchive: (document: DocumentView) => void
  onAdd: (category: VehicleDocumentCategoryCode) => void
}

function fileHref(truckId: string, documentId: string, versionId: string, download: boolean) {
  const base = `/api/trucks/${encodeURIComponent(truckId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/file`
  return download ? `${base}?dl=1` : base
}

function VersionDetails({ version }: { version: DocumentVersionView }) {
  const lines = [
    version.issuedOn && `Date du document : ${formatDateFr(version.issuedOn)}`,
    (version.validFrom || version.validUntil) && `Validité : ${formatDateFr(version.validFrom)} → ${formatDateFr(version.validUntil)}`,
    version.issuerName && `Émetteur : ${version.issuerName}`,
    version.referenceNumber && `Référence : ${version.referenceNumber}`,
    version.mileage != null && `Kilométrage indiqué : ${version.mileage.toLocaleString("fr-FR")} km (information, compteur inchangé)`,
    version.maintenanceEntryId && "Liée à une intervention du journal d'entretien",
  ].filter(Boolean) as string[]
  return <div className="text-xs text-slate-600">
    {lines.map((line) => <p key={line}>{line}</p>)}
    {version.observations && <p className="mt-1 whitespace-pre-wrap">{version.observations}</p>}
    <p className="mt-1 text-slate-500">
      {version.originalFilename} · {formatBytes(version.sizeBytes)} · ajouté le {formatInstantFr(version.uploadedAt)} par {version.uploadedByName}
      {version.verifiedAt ? ` · validé le ${formatInstantFr(version.verifiedAt)} par ${version.verifiedByName}` : " · non validé"}
    </p>
  </div>
}

/** Rubrique d'un camion : dossiers actifs, archivés et historique des versions à la demande. */
export function VehicleDocumentCategorySection(props: CategorySectionProps) {
  const { category, active, archived, canManage, truckActive, busy, truckId } = props
  return <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label={category.label}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><FileText className="h-4 w-4 text-slate-400" aria-hidden="true" />{category.label}</h3>
        <p className="mt-1 text-xs text-slate-500">{CATEGORY_HINTS[category.code]}</p>
      </div>
      {canManage && truckActive && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => props.onAdd(category.code)}>Ajouter une pièce</Button>}
    </div>
    {active.length === 0 && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-500"><span className={`mr-2 rounded px-2 py-0.5 text-xs font-medium ${documentStatusTone("MISSING")}`}>{documentStatusLabel("MISSING")}</span>Aucune pièce enregistrée dans cette rubrique.</p>}
    <ul className="mt-3 space-y-3">
      {[...active, ...archived].map((document) => {
        const version = document.currentVersion
        const expanded = props.expandedId === document.id
        const history = props.versions[document.id]
        return <li key={document.id} className={`rounded-lg border p-3 ${document.archivedAt ? "border-slate-100 bg-slate-50/60" : "border-slate-100"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${documentStatusTone(document.status)}`}>{documentStatusLabel(document.status)}</span>
            <strong className="text-sm text-slate-800">{document.title}</strong>
            {version && <span className="text-xs text-slate-500">version {version.versionNumber}</span>}
            {remainingLabel(document) && <span className="text-xs text-slate-600">· {remainingLabel(document)}</span>}
          </div>
          {document.archivedAt && <p className="mt-1 text-xs text-slate-500">Archivé le {formatInstantFr(document.archivedAt)}{document.archiveReason ? ` · ${document.archiveReason}` : ""}</p>}
          {version && <div className="mt-2"><VersionDetails version={version} /></div>}
          <div className="mt-2 flex flex-wrap gap-2">
            {version && <>
              <a className="text-xs font-medium text-[#0f3460] underline-offset-2 hover:underline" href={fileHref(truckId, document.id, version.id, false)} target="_blank" rel="noopener noreferrer">Consulter</a>
              <a className="text-xs font-medium text-[#0f3460] underline-offset-2 hover:underline" href={fileHref(truckId, document.id, version.id, true)}>Télécharger</a>
            </>}
            <button type="button" className="text-xs text-slate-600 underline-offset-2 hover:underline" aria-expanded={expanded} onClick={() => props.onToggleVersions(document)}>{expanded ? "Masquer l'historique" : "Historique des versions"}</button>
            {canManage && !document.archivedAt && <>
              {version && !version.verifiedAt && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => props.onVerify(document)}>Marquer comme vérifié</Button>}
              {truckActive && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => props.onReplace(document)}>Remplacer</Button>}
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => props.onArchive(document)}>Archiver</Button>
            </>}
          </div>
          {expanded && <div className="mt-3 border-t border-slate-100 pt-3">
            {!history ? <p className="text-xs text-slate-500">Chargement de l'historique…</p>
              : history.length === 0 ? <p className="text-xs text-slate-500">Aucune version.</p>
              : <ol className="space-y-2">{history.map((item) => <li key={item.id} className="rounded bg-slate-50 p-2">
                <p className="text-xs font-medium text-slate-700">Version {item.versionNumber} · {documentStatusLabel(item.status)}{item.supersededAt ? ` · remplacée le ${formatInstantFr(item.supersededAt)}` : ""}</p>
                <VersionDetails version={item} />
                <div className="mt-1 flex gap-2">
                  <a className="text-xs text-[#0f3460] hover:underline" href={fileHref(truckId, document.id, item.id, false)} target="_blank" rel="noopener noreferrer">Consulter</a>
                  <a className="text-xs text-[#0f3460] hover:underline" href={fileHref(truckId, document.id, item.id, true)}>Télécharger</a>
                </div>
              </li>)}</ol>}
          </div>}
        </li>
      })}
    </ul>
  </section>
}
