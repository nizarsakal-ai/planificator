// Rendu imprimable d'un contrat de location (fournisseur ou client) : en-tête, parties, conditions, signatures.
import { BLANK, type ContractDocument } from "@/lib/equipment/rental-contract-document"

export function ContractDocumentView({ doc, logo, companyName }: { doc: ContractDocument; logo: string | null; companyName: string }) {
  return (
      <article data-print-document="" className="mx-auto max-w-[210mm] rounded-lg border border-slate-200 bg-white px-8 py-10 text-[13px] leading-relaxed text-slate-800 print:max-w-none print:rounded-none print:border-0 print:p-0">
        <header className="flex items-start justify-between gap-6 border-b border-slate-300 pb-4">
          <div>
            <h1 className="text-xl font-bold uppercase tracking-wide text-slate-900">{doc.title}</h1>
            <p className="mt-1 text-slate-600">{doc.reference}</p>
            {doc.statusNote && <p className="mt-2 inline-block rounded border border-red-300 px-2 py-0.5 text-xs font-semibold uppercase text-red-700">{doc.statusNote}</p>}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {logo && <img src={logo} alt={companyName} className="max-h-16 max-w-[160px] object-contain" />}
        </header>

        <section className="mt-6">
          <h2 className="text-sm font-bold uppercase text-slate-900">Entre les soussignés</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 print:grid-cols-2">
            {[doc.lessor, doc.lessee].map((p) => (
              <div key={p.role} className="rounded border border-slate-300 p-3">
                <p className="text-xs font-semibold uppercase text-slate-500">{p.role}</p>
                <p className="mt-1 font-semibold text-slate-900">{p.name}</p>
                {p.lines.map((l) => <p key={l} className="text-slate-700">{l}</p>)}
              </div>
            ))}
          </div>
          <p className="mt-3">Il a été convenu ce qui suit.</p>
        </section>

        <section className="mt-6 break-inside-avoid">
          <h2 className="text-sm font-bold uppercase text-slate-900">Conditions particulières</h2>
          <table className="mt-2 w-full border-collapse">
            <tbody>
              {doc.particular.map((r) => (
                <tr key={r.label} className="border-b border-slate-200">
                  <th className="w-1/2 py-1.5 pr-3 text-left align-top font-medium text-slate-600">{r.label}</th>
                  <td className="py-1.5 tabular-nums text-slate-900">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-6">
          <h2 className="text-sm font-bold uppercase text-slate-900">Conditions générales de location</h2>
          {doc.articles.map((a, i) => (
            <div key={a.title} className="mt-3 break-inside-avoid">
              <h3 className="font-semibold text-slate-900">Article {i + 1} · {a.title}</h3>
              {a.paragraphs.map((p, j) => <p key={j} className="mt-1 whitespace-pre-line text-justify">{p}</p>)}
            </div>
          ))}
        </section>

        <section className="mt-8 break-inside-avoid">
          <p>Fait en deux exemplaires originaux, à {BLANK}, le {BLANK}.</p>
          <div className="mt-4 grid grid-cols-2 gap-6">
            {[doc.lessor, doc.lessee].map((p) => (
              <div key={p.role} className="h-36 rounded border border-slate-300 p-3">
                <p className="font-semibold text-slate-900">{p.role} · {p.name}</p>
                <p className="text-xs text-slate-500">Nom, qualité, cachet et signature, précédés de la mention « Lu et approuvé »</p>
              </div>
            ))}
          </div>
        </section>
      </article>
  )
}
