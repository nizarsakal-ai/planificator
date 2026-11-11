import type { ReactNode } from "react"
import { ChevronDown, Folder } from "lucide-react"
import { categoryDefinition } from "@/lib/hr-documents/catalog"

const FOLDERS = [
  ["administrative", "Identité et administratif"],
  ["contract", "Contrat et avenants"],
  ["pay", "Bulletins de paie"],
  ["training", "Formations et CACES"],
  ["leave", "Absences et congés"],
  ["followup", "Suivi RH et départ"],
] as const

type FolderKey = typeof FOLDERS[number][0]
type FolderEntry = { id: string; category: string; period: string }

function folderFor(category: string): FolderKey {
  if (category === "PAYSLIP") return "pay"
  if (category === "LEAVE_DOCUMENT") return "leave"
  if (["EMPLOYER_CERTIFICATE", "WORK_CERTIFICATE", "FINAL_SETTLEMENT"].includes(category)) return "followup"
  const family = categoryDefinition(category)?.family
  if (family === "CONTRACT") return "contract"
  if (family === "QUALIFICATION") return "training"
  if (family === "IDENTITY" || family === "SOCIAL" || family === "HEALTH") return "administrative"
  return "followup"
}

const monthFormat = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" })
const validPeriod = /^\d{4}-(0[1-9]|1[0-2])$/
export function documentMonth(period: string) {
  if (!validPeriod.test(period)) return period
  const label = monthFormat.format(new Date(period + "-01T00:00:00Z"))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function DocumentFolders<T extends FolderEntry>({ documents, renderDocument }: {
  documents: T[]
  renderDocument: (doc: T, month?: string) => ReactNode
}) {
  const groups = new Map<FolderKey, T[]>()
  for (const doc of documents) {
    const folder = folderFor(doc.category)
    const group = groups.get(folder)
    if (group) group.push(doc)
    else groups.set(folder, [doc])
  }

  const years = new Map<string, T[]>()
  for (const doc of [...(groups.get("pay") ?? [])].sort((a, b) => b.period.localeCompare(a.period))) {
    const year = validPeriod.test(doc.period) ? doc.period.slice(0, 4) : "Sans période"
    const group = years.get(year)
    if (group) group.push(doc)
    else years.set(year, [doc])
  }

  return <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Sous-dossiers RH">
    {FOLDERS.map(([key, label]) => {
      const entries = groups.get(key) ?? []
      return <section key={key} className={`min-w-0 overflow-hidden rounded-xl border bg-white shadow-sm ${key === "pay" ? "border-blue-300" : "border-slate-200"}`}>
        <h3 className="flex items-center gap-2.5 border-b border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
          <Folder aria-hidden="true" className="size-5 shrink-0 text-blue-950" />{label}
        </h3>
        {!entries.length ? <p className="px-4 py-5 text-sm text-slate-500">Aucun document affiché</p>
          : key === "pay" ? <div className="space-y-2 p-2.5">
            {[...years].map(([year, docs], index) => <details key={year} open={index === 0} className="group rounded-lg">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 [&::-webkit-details-marker]:hidden">
                <ChevronDown aria-hidden="true" className="size-4 -rotate-90 group-open:rotate-0" />
                {year}<span className="ml-auto text-xs font-normal text-slate-600">{docs.length} PDF</span>
              </summary>
              <ul className="divide-y divide-slate-100">{docs.map(doc => renderDocument(doc, documentMonth(doc.period)))}</ul>
            </details>)}
          </div> : <ul className="divide-y divide-slate-100">{entries.map(doc => renderDocument(doc))}</ul>}
      </section>
    })}
  </div>
}
